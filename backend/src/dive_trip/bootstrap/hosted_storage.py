"""Deployment-only tables, never applied to local or retained evaluation data."""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dive_trip.platform.database import Database

HOSTED_MIGRATIONS = ("hosted_schema.sql",)


@dataclass(frozen=True)
class HostedLimits:
    global_per_minute: int = 600
    client_per_minute: int = 60
    sessions: int = 1000
    trips: int = 200
    owner_trips: int = 5

    def __post_init__(self) -> None:
        values = self.values()
        if any(type(value) is not int or not 1 <= value <= 10000 for value in values):
            raise ValueError("HOSTED_LIMITS_INVALID")
        if (
            self.client_per_minute > self.global_per_minute
            or self.owner_trips > self.trips
        ):
            raise ValueError("HOSTED_LIMITS_INVALID")

    def values(self) -> tuple[int, ...]:
        return (
            self.global_per_minute,
            self.client_per_minute,
            self.sessions,
            self.trips,
            self.owner_trips,
        )


def schema_source(name: str = HOSTED_MIGRATIONS[0]) -> tuple[str, str]:
    source = Path(__file__).with_name(name).read_text()
    return source, hashlib.sha256(source.encode()).hexdigest()


def install_hosted_schema(
    database: Database, limits: HostedLimits = HostedLimits()
) -> None:
    with database.transaction() as connection:
        name = connection.execute("SELECT current_database() AS name").fetchone()
        if name is None or not (
            (name["name"] == "dive_trip_demo" and database.schema == "workbench_demo")
            or (
                name["name"] == "postgres"
                and re.fullmatch(r"python_test_[a-f0-9]{32}", database.schema)
            )
        ):
            raise ValueError("HOSTED_DATABASE_TARGET_REQUIRED")
        connection.execute("SELECT pg_advisory_xact_lock(724931,2)")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS hosted_migrations "
            "(version integer PRIMARY KEY CHECK(version>0),checksum text NOT NULL)"
        )
        prior = connection.execute(
            "SELECT * FROM hosted_migrations ORDER BY version"
        ).fetchall()
        if len(prior) > len(HOSTED_MIGRATIONS):
            raise ValueError("HOSTED_SCHEMA_CHECKSUM_MISMATCH")
        for version, row in enumerate(prior, start=1):
            if (
                row["version"] != version
                or row["checksum"] != schema_source(HOSTED_MIGRATIONS[version - 1])[1]
            ):
                raise ValueError("HOSTED_SCHEMA_CHECKSUM_MISMATCH")
        if not prior:
            occupied = connection.execute(
                "SELECT EXISTS(SELECT 1 FROM sessions) "
                "OR EXISTS(SELECT 1 FROM trips) "
                "OR EXISTS(SELECT 1 FROM planning_executions) AS occupied"
            ).fetchone()
            if occupied is None or occupied["occupied"]:
                raise ValueError("HOSTED_EMPTY_DATABASE_REQUIRED")
        for version in range(len(prior) + 1, len(HOSTED_MIGRATIONS) + 1):
            source, checksum = schema_source(HOSTED_MIGRATIONS[version - 1])
            connection.execute(source)
            connection.execute(
                "INSERT INTO hosted_migrations(version,checksum) VALUES(%s,%s)",
                (version, checksum),
            )
        connection.execute("SELECT pg_advisory_xact_lock(724931,1)")
        connection.execute(
            "INSERT INTO hosted_limits VALUES(true,%s,%s,%s,%s,%s) "
            "ON CONFLICT(singleton) DO UPDATE SET "
            "global_per_minute=excluded.global_per_minute,client_per_minute=excluded.client_per_minute,"
            "sessions=excluded.sessions,trips=excluded.trips,owner_trips=excluded.owner_trips",
            limits.values(),
        )


def require_hosted_schema(database: Database) -> None:
    with database.transaction() as connection:
        rows = connection.execute(
            "SELECT * FROM hosted_migrations ORDER BY version"
        ).fetchall()
        if len(rows) != len(HOSTED_MIGRATIONS) or any(
            row["version"] != version
            or row["checksum"] != schema_source(HOSTED_MIGRATIONS[version - 1])[1]
            for version, row in enumerate(rows, start=1)
        ):
            raise ValueError("HOSTED_SCHEMA_MIGRATION_REQUIRED")


class HostedIngressStore:
    def __init__(self, database: Database) -> None:
        self.database = database

    def consume(self, nonce: str, client_hash: str) -> int:
        """Single shared transaction: replay fence and per-client minute budget."""
        with self.database.transaction() as connection:
            prior = connection.execute(
                "SELECT nonce FROM hosted_ingress_nonces WHERE nonce=%s",
                (nonce,),
            ).fetchone()
            if prior is not None:
                return 409
            global_budget = connection.execute(
                "INSERT INTO hosted_ip_windows(client_hash,minute,count) "
                "VALUES('global',floor(extract(epoch FROM clock_timestamp())/60),1) "
                "ON CONFLICT(client_hash,minute) DO UPDATE "
                "SET count=hosted_ip_windows.count+1 "
                "WHERE hosted_ip_windows.count<(SELECT global_per_minute "
                "FROM hosted_limits WHERE singleton) RETURNING count"
            ).fetchone()
            if global_budget is None:
                return 429
            added = connection.execute(
                "INSERT INTO hosted_ingress_nonces(nonce,expires_at) "
                "VALUES(%s,clock_timestamp()+interval '2 minutes') "
                "ON CONFLICT DO NOTHING RETURNING nonce",
                (nonce,),
            ).fetchone()
            if added is None:
                return 409
            limited = connection.execute(
                "INSERT INTO hosted_ip_windows(client_hash,minute,count) "
                "VALUES(%s,floor(extract(epoch FROM clock_timestamp())/60),1) "
                "ON CONFLICT(client_hash,minute) DO UPDATE "
                "SET count=hosted_ip_windows.count+1 "
                "WHERE hosted_ip_windows.count<(SELECT client_per_minute "
                "FROM hosted_limits WHERE singleton) RETURNING count",
                (client_hash,),
            ).fetchone()
            return 200 if limited else 429

    def prune(self) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM hosted_ingress_nonces WHERE expires_at<clock_timestamp()"
            )
            connection.execute(
                "DELETE FROM hosted_ip_windows "
                "WHERE minute<floor(extract(epoch FROM clock_timestamp())/60)-10"
            )


def recovery_snapshot(database: Database) -> dict[str, Any]:
    """Bounded journal projection for the independent recovery exporter."""
    with database.transaction() as connection:
        control = connection.execute(
            "SELECT * FROM hosted_control WHERE singleton FOR SHARE"
        ).fetchone()
        if control is None:
            raise ValueError("HOSTED_RECOVERY_CONTROL_REQUIRED")
        rows = connection.execute(
            "SELECT * FROM hosted_recovery_journal ORDER BY sequence LIMIT 100001"
        ).fetchall()
        if len(rows) > 100000:
            raise ValueError("HOSTED_RECOVERY_CAPACITY_REACHED")
        if control["last_sequence"] != len(rows) or any(
            row["sequence"] != position for position, row in enumerate(rows, start=1)
        ):
            raise ValueError("HOSTED_RECOVERY_HISTORY_INCOMPLETE")
        return {"control": control, "records": rows}
