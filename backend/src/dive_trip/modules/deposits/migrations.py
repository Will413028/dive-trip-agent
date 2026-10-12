"""Separate migration chain for the PayPal demo profile.

Deposit tables live outside the product chain so product and evaluation schemas keep
their closed-world table inventory; only the demo profile and deposit tests apply this.
"""

import hashlib
from pathlib import Path

from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError

DEPOSIT_MIGRATIONS = ("001-deposits",)


def migrate_deposits(database: Database) -> None:
    root = Path(__file__).resolve().parents[5] / "migrations" / "deposits"
    with database.transaction() as connection:
        connection.execute(
            "SELECT pg_advisory_xact_lock(724913,hashtext(current_schema()))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS deposit_schema_migrations ("
            "id text PRIMARY KEY,checksum text NOT NULL,"
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {
            row["id"]: row["checksum"]
            for row in connection.execute(
                "SELECT id,checksum FROM deposit_schema_migrations"
            ).fetchall()
        }
        if set(applied) - set(DEPOSIT_MIGRATIONS):
            raise DomainError("UNKNOWN_MIGRATION")
        for identity in DEPOSIT_MIGRATIONS:
            sql = (root / f"{identity}.sql").read_text()
            checksum = hashlib.sha256(sql.encode()).hexdigest()
            if identity in applied:
                if applied[identity] != checksum:
                    raise DomainError("MIGRATION_CHECKSUM_MISMATCH")
                continue
            connection.execute(sql)
            connection.execute(
                "INSERT INTO deposit_schema_migrations(id,checksum) VALUES(%s,%s)",
                (identity, checksum),
            )
