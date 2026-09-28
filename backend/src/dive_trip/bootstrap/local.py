"""Explicit persistent loopback fixture launcher; migration is a separate action."""

import argparse
import asyncio
import json
import signal
from pathlib import Path

import psycopg
from temporalio.testing import WorkflowEnvironment

from dive_trip.application.runtime_binding import bind_temporal
from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.errors import DomainError
from dive_trip.platform.migrations import migrate, require_current

from .dev import unused_port
from .stack import pinned_node, serve_stack


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("migrate", "serve", "retention"))
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument(
        "--schema", choices=("workbench_demo",), default="workbench_demo"
    )
    parser.add_argument("--temporal-storage", type=Path)
    parser.add_argument("--temporal-binary", type=Path)
    parser.add_argument("--port", type=int, default=4318)
    parser.add_argument("--production", action="store_true")
    args = parser.parse_args()
    if any(not 1 <= port <= 65535 for port in (args.database_port, args.port)):
        parser.error("INVALID_PORT")
    if args.action == "serve" and args.temporal_storage is None:
        parser.error("PERSISTENT_TEMPORAL_STORAGE_REQUIRED")
    if args.action == "serve" and args.temporal_binary is None:
        parser.error("EXISTING_TEMPORAL_BINARY_REQUIRED")
    return args


async def temporal_binary(path: Path) -> str:
    binary = path.resolve(strict=True)
    process = await asyncio.create_subprocess_exec(
        str(binary),
        "--version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={},
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 5)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode or output.strip() != (
        b"temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)"
    ):
        raise DomainError("TEMPORAL_VERSION_MISMATCH")
    return str(binary)


async def run(args: argparse.Namespace) -> None:
    binary = (
        await temporal_binary(args.temporal_binary) if args.action == "serve" else None
    )
    conninfo = fixture_conninfo(args.database_port)
    # Cooperating launchers/migrations serialize without touching any trip row.
    # Cutover also requires stopping old ADK writers, which do not own this lock.
    with psycopg.connect(conninfo, autocommit=True) as lease:
        if lease.execute("SELECT current_database()").fetchone() != ("dive_trip_test",):
            raise DomainError("DATABASE_TARGET_MISMATCH")
        if args.action != "retention" and lease.execute(
            "SELECT pg_try_advisory_lock(724924,hashtext('workbench_demo'))"
        ).fetchone() != (True,):
            raise DomainError("LOCAL_RUNTIME_ALREADY_RUNNING")
        if args.action == "migrate":
            lease.execute("CREATE SCHEMA IF NOT EXISTS workbench_demo")
        database = Database(conninfo, "workbench_demo")
        database.open()
        try:
            if args.action == "migrate":
                migrate(database)
                print("WORKBENCH_DEMO_MIGRATIONS_CURRENT")
                return
            require_current(database)
            if args.action == "retention":
                with database.transaction() as connection:
                    connection.execute("SET TRANSACTION READ ONLY")
                    counts = connection.execute(
                        "SELECT "
                        "(SELECT count(*) FROM trips t JOIN sessions s "
                        "ON s.id=t.owner_id WHERE "
                        "LEAST(t.expires_at,s.expires_at)<=clock_timestamp()) "
                        "AS expired_trips, "
                        "(SELECT count(*) FROM trip_deletion_jobs "
                        "WHERE status='deleting') AS pending_deletions, "
                        "(SELECT count(*) FROM sessions "
                        "WHERE expires_at<=clock_timestamp()) AS expired_sessions"
                    ).fetchone()
                print(
                    json.dumps(
                        {
                            "schema": "workbench_demo",
                            "mode": "read-only",
                            **(counts or {}),
                        }
                    )
                )
                return
            node, path = await pinned_node()
            storage = args.temporal_storage.resolve()
            storage.parent.mkdir(parents=True, exist_ok=True)
            stopped = asyncio.Event()
            for signum in (signal.SIGINT, signal.SIGTERM):
                asyncio.get_running_loop().add_signal_handler(signum, stopped.set)
            temporal_port, api_port = unused_port(), unused_port()
            async with await WorkflowEnvironment.start_local(
                port=temporal_port,
                dev_server_database_filename=str(storage),
                dev_server_existing_path=binary,
            ) as environment:
                await bind_temporal(database, environment.client)
                await serve_stack(
                    schema="workbench_demo",
                    database_port=args.database_port,
                    temporal_port=temporal_port,
                    api_port=api_port,
                    web_port=args.port,
                    production=args.production,
                    stopped=stopped,
                    node=node,
                    path=path,
                )
            # No database schema or SQLite history is removed on shutdown.
        finally:
            database.close()


def main() -> None:
    args = arguments()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except DomainError as error:
        raise SystemExit(error.code) from None
    except Exception:
        raise SystemExit("LOCAL_RUNTIME_FAILED") from None


if __name__ == "__main__":
    main()
