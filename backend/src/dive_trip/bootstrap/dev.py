"""Disposable fixture stack for browser tests, with only explicitly owned resources."""

import argparse
import asyncio
import os
import re
import signal
import socket
import sys
from uuid import uuid4

import psycopg
from psycopg import sql
from temporalio.testing import WorkflowEnvironment

from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.migrations import migrate

from .stack import ROOT, pinned_node, serve_stack


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def run(production: bool) -> None:
    project = os.environ.get("COMPOSE_PROJECT_NAME", "")
    if not re.fullmatch(r"dive-trip-[a-z0-9][a-z0-9-]{5,80}", project):
        raise ValueError("ISOLATED_COMPOSE_PROJECT_REQUIRED")
    node, path = await pinned_node()
    context_process = await asyncio.create_subprocess_exec(
        "docker",
        "context",
        "show",
        stdout=asyncio.subprocess.PIPE,
    )
    context_output, _ = await asyncio.wait_for(context_process.communicate(), 5)
    context = context_output.decode().strip()
    if context_process.returncode or not re.fullmatch(r"[a-zA-Z0-9_.-]+", context):
        raise ValueError("DOCKER_CONTEXT_REQUIRED")
    compose = await asyncio.create_subprocess_exec(
        "docker",
        "--context",
        context,
        "compose",
        "--env-file",
        "/dev/null",
        "-f",
        str(ROOT / "compose.test.yml"),
        "port",
        "dive-trip-test-db",
        "5432",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={"PATH": path, "COMPOSE_PROJECT_NAME": project},
    )
    output, _ = await asyncio.wait_for(compose.communicate(), 10)
    match = re.fullmatch(rb"127\.0\.0\.1:(\d+)\s*", output)
    if compose.returncode or match is None:
        raise ValueError("DEDICATED_TEST_DATABASE_REQUIRED")
    database_port = int(match[1])
    conninfo = fixture_conninfo(database_port)
    schema = f"e2e_{uuid4().hex}"
    created = False
    environment: WorkflowEnvironment | None = None
    stopped = asyncio.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(signum, stopped.set)
    try:
        with psycopg.connect(conninfo, autocommit=True) as connection:
            if connection.execute("SELECT current_database()").fetchone() != (
                "dive_trip_test",
            ):
                raise ValueError("DATABASE_TARGET_MISMATCH")
            connection.execute(
                sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema))
            )
            created = True
        database = Database(conninfo, schema)
        database.open()
        try:
            migrate(database)
        finally:
            database.close()
        temporal_port, api_port = unused_port(), unused_port()
        environment = await WorkflowEnvironment.start_local(port=temporal_port)
        await serve_stack(
            schema=schema,
            database_port=database_port,
            temporal_port=temporal_port,
            api_port=api_port,
            web_port=4319,
            production=production,
            stopped=stopped,
            node=node,
            path=path,
        )
    finally:
        if environment is not None:
            await environment.shutdown()
        if created:
            with psycopg.connect(conninfo, autocommit=True) as connection:
                connection.execute(
                    sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema))
                )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--e2e", action="store_true", required=True)
    parser.add_argument("--production", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.production))
    except Exception as error:
        # All launcher errors are local bounded diagnostics; do not dump conninfo.
        print(f"PYTHON_WORKBENCH_FAILED: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
