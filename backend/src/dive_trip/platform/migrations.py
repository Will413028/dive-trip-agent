"""Immutable SQL migrations with the existing checksum ledger and startup lock."""

import hashlib
from pathlib import Path

from .database import Database
from .errors import DomainError

MIGRATIONS = (
    "001-core",
    "002-proposals",
    "003-proposal-catalog",
    "004-agent-runs",
    "005-quota",
    "006-agent-admission",
    "007-model-transition",
    "008-sharing",
    "009-retention",
    "010-openrouter-provider",
    "011-cloudflare-provider",
    "012-grounded-answers",
    "013-zero-model-continuation",
    "014-temporal-executions",
    "015-durable-deletion",
    "016-temporal-service-binding",
    "017-workflow-delivery",
    "018-temporal-execution-identity",
    "019-evaluation-fault",
    "020-active-executor",
)


def sources() -> list[tuple[str, str, str]]:
    root = Path(__file__).resolve().parents[4] / "migrations"
    result = []
    for name in MIGRATIONS:
        sql = (root / f"{name}.sql").read_text()
        result.append((name, sql, hashlib.sha256(sql.encode()).hexdigest()))
    return result


def migrate(database: Database) -> None:
    migrations = sources()
    with database.transaction() as connection:
        connection.execute(
            "SELECT pg_advisory_xact_lock(724913,hashtext(current_schema()))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "id text PRIMARY KEY,checksum text NOT NULL,"
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {
            row["id"]: row["checksum"]
            for row in connection.execute(
                "SELECT id,checksum FROM schema_migrations"
            ).fetchall()
        }
        if set(applied) - set(MIGRATIONS):
            raise DomainError("UNKNOWN_MIGRATION")
        for identity, sql, checksum in migrations:
            if identity in applied:
                if applied[identity] != checksum:
                    raise DomainError("MIGRATION_CHECKSUM_MISMATCH")
                continue
            connection.execute(sql)
            connection.execute(
                "INSERT INTO schema_migrations(id,checksum) VALUES(%s,%s)",
                (identity, checksum),
            )


def require_current(database: Database) -> None:
    expected = {identity: checksum for identity, _, checksum in sources()}
    with database.transaction() as connection:
        actual = {
            row["id"]: row["checksum"]
            for row in connection.execute(
                "SELECT id,checksum FROM schema_migrations"
            ).fetchall()
        }
    if actual != expected:
        raise DomainError("MIGRATIONS_REQUIRED")
