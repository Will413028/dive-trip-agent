"""Integration resources are created here, never read from environment files."""

import subprocess
import time
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.migrations import migrate


@pytest.fixture(scope="session")
def postgres():
    context = subprocess.run(
        ["docker", "context", "show"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.strip()
    docker = ["docker", "--context", context]
    name = f"dive-python-test-{uuid4().hex[:12]}"
    launched = subprocess.run(
        [
            *docker,
            "run",
            "--detach",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--publish",
            "127.0.0.1::5432",
            "--env",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "postgres:18-alpine",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if launched.returncode:
        pytest.fail(f"Isolated PostgreSQL could not start: {launched.stderr.strip()}")
    try:
        port = (
            subprocess.run(
                [*docker, "port", name, "5432/tcp"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            .stdout.strip()
            .split(":")[-1]
        )
        conninfo = fixture_conninfo(int(port), "postgres")
        deadline = time.monotonic() + 30
        while True:
            try:
                with psycopg.connect(conninfo):
                    break
            except psycopg.OperationalError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        yield conninfo
    finally:
        subprocess.run(
            [*docker, "stop", "--time", "5", name],
            check=True,
            capture_output=True,
            timeout=15,
        )


@pytest.fixture
def database(postgres):
    schema = f"python_test_{uuid4().hex}"
    with psycopg.connect(postgres, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        connection.execute(
            sql.SQL("SET search_path TO {}").format(sql.Identifier(schema))
        )
    database = Database(postgres, schema)
    database.open()
    try:
        migrate(database)
        yield database
    finally:
        database.close()
        with psycopg.connect(postgres, autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema))
            )
