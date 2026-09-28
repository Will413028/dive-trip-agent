"""Private controller child with owned PostgreSQL/Temporal evaluation storage."""

import argparse
import asyncio
import json
import re
import signal
import socket
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.testing import WorkflowEnvironment

from dive_trip.application.agent_runtime import SyntheticGeneration
from dive_trip.application.evaluation_runtime import OwnedGeneration
from dive_trip.application.runtime_binding import bind_temporal
from dive_trip.modules.usage.provider import CLOUDFLARE_MODEL
from dive_trip.modules.usage.public import Policy, ProviderBinding
from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_channel import Command, EvaluationChannel
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer
from dive_trip.platform.evaluation_storage import drop_if_unchanged
from dive_trip.platform.migrations import migrate

from .evaluation_generation import reviewed_cloudflare_generation
from .evaluation_session import EvaluationSession, EvaluationSetup
from .local import temporal_binary


class OwnedSynthetic(SyntheticGeneration):
    async def aclose(self) -> None:
        pass


async def run(args: argparse.Namespace) -> None:
    # The controller creates only this inherited duplex. No fallback to stdin,
    # URL, public listener or ambient credential discovery is provided.
    reader, writer = await asyncio.open_connection(
        sock=socket.socket(fileno=3), limit=1048576
    )
    channel = EvaluationChannel(reader, writer)
    binary = await temporal_binary(args.temporal_binary)
    if not re.fullmatch(r"python_test_[a-f0-9]{32}", args.schema):
        raise DomainError("EVALUATION_CONTEXT_REQUIRED")
    if args.storage.is_symlink():
        raise DomainError("EVALUATION_STORAGE_REQUIRED")
    root = args.storage.resolve(strict=True)
    if list(root.iterdir()) != [root / "context.json"]:
        raise DomainError("EVALUATION_STORAGE_REQUIRED")
    context = json.loads((root / "context.json").read_text())
    if context != {"schema": args.schema, "databasePort": args.database_port}:
        raise DomainError("EVALUATION_STORAGE_REQUIRED")
    provider = ProviderBinding(
        provider="cloudflare", model=CLOUDFLARE_MODEL, accountId=args.account_id
    )
    policy = Policy(
        enabled=True,
        dailyBudgetMicros=args.budget_micros,
        priceBasis="synthetic" if args.synthetic else "server-verified",
        reservationTtlMs=60000,
    )
    conninfo = fixture_conninfo(args.database_port)
    with psycopg.connect(conninfo, autocommit=True) as admin:
        if admin.execute("SELECT current_database()").fetchone() != ("dive_trip_test",):
            raise DomainError("DATABASE_TARGET_MISMATCH")
        # CREATE without IF NOT EXISTS proves this process owns the new schema.
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(args.schema)))
    database = Database(conninfo, args.schema)
    database.open()
    cleanup: str | None = None
    session: EvaluationSession | None = None
    try:
        migrate(database)
        async with await WorkflowEnvironment.start_local(
            dev_server_database_filename=str(root / "temporal.sqlite"),
            dev_server_existing_path=binary,
            plugins=[PydanticAIPlugin()],
        ) as environment:
            await bind_temporal(database, environment.client)

            async def load() -> OwnedGeneration:
                credential = await channel.load_credential()
                if args.synthetic:
                    return OwnedSynthetic(provider, credential)
                return await reviewed_cloudflare_generation(provider, credential)

            # Random key belongs to this campaign lifetime; never reset per case.
            import secrets

            session = EvaluationSession(
                database,
                environment.client,
                provider,
                policy,
                EvaluationLoopbackPeer(secrets.token_bytes(32)),
                load,
            )

            async def handle(command: Command) -> Any:
                nonlocal cleanup
                assert session is not None
                match command.operation:
                    case "setup":
                        value = await session.setup(
                            EvaluationSetup.model_validate(command.input)
                        )
                        return value.model_dump(mode="json")
                    case "request":
                        if set(command.input) != {"path", "body"} or not isinstance(
                            command.input["path"], str
                        ):
                            raise DomainError("EVALUATION_PROTOCOL_INVALID")
                        response = await session.request(
                            command.input["path"], command.input["body"]
                        )
                        return response.model_dump()
                    case "audit":
                        if set(command.input) != {"runId"} or not isinstance(
                            command.input["runId"], str
                        ):
                            raise DomainError("EVALUATION_PROTOCOL_INVALID")
                        return (await session.audit(command.input["runId"])).model_dump(
                            mode="json"
                        )
                    case "capture":
                        if command.input:
                            raise DomainError("EVALUATION_PROTOCOL_INVALID")
                        return await session.capture()
                    case "finish":
                        if (
                            set(command.input) != {"cleanup"}
                            or type(command.input["cleanup"]) is not bool
                        ):
                            raise DomainError("EVALUATION_PROTOCOL_INVALID")
                        await session.close()
                        cleanup = (
                            session.cleanup_fingerprint()
                            if command.input["cleanup"]
                            else None
                        )
                        return {"cleanup": command.input["cleanup"]}

            try:
                await channel.serve(handle)
            finally:
                await session.close()
        # Approval is only useful after actual worker/SDK/Temporal shutdown.
        if cleanup:
            drop_if_unchanged(database, cleanup)
            for suffix in ("", "-shm", "-wal"):
                (root / f"temporal.sqlite{suffix}").unlink(missing_ok=True)
    finally:
        database.close()
        writer.close()
        await writer.wait_closed()


async def supervised(args: argparse.Namespace) -> None:
    task = asyncio.create_task(run(args))
    loop = asyncio.get_running_loop()

    def stop() -> None:
        if not task.cancelling():
            task.cancel()

    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop)
    await task


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--storage", type=Path, required=True)
    parser.add_argument("--temporal-binary", type=Path, required=True)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--budget-micros", type=int, required=True)
    parser.add_argument("--synthetic", action="store_true")
    try:
        asyncio.run(supervised(parser.parse_args()))
    except BaseException:
        # No SDK/DB exception, argument, credential or native history on stderr.
        raise SystemExit("EVALUATION_CHILD_FAILED") from None


if __name__ == "__main__":
    main()
