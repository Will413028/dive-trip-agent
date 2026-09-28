"""Private isolated evaluation storage fingerprint and authorized final cleanup."""

import hashlib
import re
from typing import Any

from psycopg import Connection, sql

from .database import Database
from .errors import DomainError

TABLES = tuple(
    sorted(
        (
            "schema_migrations",
            "sessions",
            "trips",
            "trip_versions",
            "proposals",
            "mutation_receipts",
            "agent_runs",
            "agent_run_events",
            "quota_global_lock",
            "quota_days",
            "quota_ips",
            "quota_session_days",
            "quota_reservations",
            "agent_invocations",
            "model_calls",
            "trip_shares",
            "quota_daily_totals",
            "planning_executions",
            "planning_model_steps",
            "planning_tool_calls",
            "trip_deletion_jobs",
            "temporal_service_binding",
        )
    )
)


def require_layout(connection: Connection[dict[str, Any]]) -> str:
    row = connection.execute("SELECT current_schema() AS name").fetchone()
    if row is None or re.fullmatch(r"python_test_[a-f0-9]{32}", row["name"]) is None:
        raise DomainError("EVALUATION_CONTEXT_REQUIRED")
    relations = connection.execute(
        "SELECT relname,relkind FROM pg_class "
        "WHERE relnamespace=current_schema()::regnamespace "
        "AND relkind NOT IN ('i','I') ORDER BY relname"
    ).fetchall()
    if [(item["relname"], item["relkind"]) for item in relations] != [
        (name, "r") for name in TABLES
    ]:
        raise DomainError("EVALUATION_EVIDENCE_CHANGED")
    return str(row["name"])


def storage_fingerprint(connection: Connection[dict[str, Any]]) -> str:
    schema = require_layout(connection)
    digest = hashlib.sha256()
    size = 0
    for name in TABLES:
        digest.update(name.encode() + b"\0")
        cursor = connection.execute(
            sql.SQL(
                "SELECT to_jsonb(t)::text AS row FROM {}.{} t ORDER BY 1 LIMIT 10001"
            ).format(sql.Identifier(schema), sql.Identifier(name))
        )
        for count, row in enumerate(cursor, 1):
            encoded = row["row"].encode()
            size += len(encoded)
            if count > 10000 or size > 64 * 1024 * 1024:
                raise DomainError("EVALUATION_STORAGE_LIMIT")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    # Only this digest is exported. Raw session/token/IP hashes stay in the DB.
    return digest.hexdigest()


def drop_if_unchanged(database: Database, expected: str) -> None:
    if re.fullmatch(r"[a-f0-9]{64}", expected) is None:
        raise DomainError("EVALUATION_CAPTURE_REQUIRED")
    with database.transaction() as connection:
        # Same DDL lock as migration. All owned workers and Temporal have stopped.
        # Table locks keep concurrent product writes out through compare + DROP.
        connection.execute("SET LOCAL statement_timeout='2000ms'")
        connection.execute("SET LOCAL lock_timeout='2000ms'")
        connection.execute(
            "SELECT pg_advisory_xact_lock(724913,hashtext(current_schema()))"
        )
        schema = require_layout(connection)
        for name in TABLES:
            connection.execute(
                sql.SQL("LOCK TABLE {}.{} IN ACCESS EXCLUSIVE MODE").format(
                    sql.Identifier(schema), sql.Identifier(name)
                )
            )
        if storage_fingerprint(connection) != expected:
            raise DomainError("EVALUATION_EVIDENCE_CHANGED")
        connection.execute(
            sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema))
        )
