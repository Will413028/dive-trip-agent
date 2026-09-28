"""Explicit database configuration; no environment-file or credential discovery."""

import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from psycopg import Connection
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def fixture_conninfo(port: int, database: str = "dive_trip_test") -> str:
    """Pin all local connection authority; never use libpq service/passfile lookup."""
    if "PGSERVICE" in os.environ or "PGSERVICEFILE" in os.environ:
        raise ValueError("AMBIENT_DATABASE_SERVICE_DISABLED")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("INVALID_PORT")
    if database not in ("postgres", "dive_trip_test"):
        raise ValueError("DEDICATED_TEST_DATABASE_REQUIRED")
    return make_conninfo(
        host="127.0.0.1",
        hostaddr="127.0.0.1",
        port=port,
        user="postgres",
        dbname=database,
        password="offline-placeholder-not-a-credential",
        passfile="/dev/null",
        sslmode="disable",
        gssencmode="disable",
        options="-c statement_timeout=10000 -c lock_timeout=5000",
        application_name="dive-trip-fixture",
        client_encoding="UTF8",
        connect_timeout=5,
    )


class Database:
    def __init__(self, conninfo: str, schema: str) -> None:
        if schema == "workbench_live" or not re.fullmatch(
            r"[a-z][a-z0-9_]{0,62}", schema
        ):
            raise ValueError("DATABASE_SCHEMA_DISABLED")
        self.schema = schema
        self.pool: ConnectionPool[Connection[dict[str, Any]]] = ConnectionPool(
            conninfo,
            kwargs={
                "row_factory": dict_row,
                "options": (
                    f"-c search_path={schema} "
                    "-c statement_timeout=10000 -c lock_timeout=5000"
                ),
            },
            min_size=1,
            max_size=8,
            timeout=10,
            open=False,
        )

    def open(self) -> None:
        self.pool.open(wait=True, timeout=10)

    def close(self) -> None:
        self.pool.close(timeout=10)

    @contextmanager
    def transaction(self) -> Iterator[Connection[dict[str, Any]]]:
        with self.pool.connection() as connection:
            with connection.transaction():
                yield connection
