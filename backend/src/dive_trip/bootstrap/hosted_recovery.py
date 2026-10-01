"""Controlled recovery: freeze a live high-water mark, reapply, then verify purge."""

import re
from datetime import UTC
from typing import Any, Literal
from uuid import uuid4

from psycopg import Connection

from dive_trip.application.deletion import persist_deletion_intent
from dive_trip.modules.usage.public import lock_global
from dive_trip.platform.database import Database

from .hosted_recovery_file import RecoveryRecord, RecoveryState, RecoveryStore
from .hosted_storage import recovery_snapshot, recovery_view, require_hosted_schema


def project(
    snapshot: dict[str, Any],
    phase: Literal["serving", "prepared", "reconciled"],
    checkpoint_id: str | None,
) -> RecoveryState:
    control = snapshot["control"]
    return RecoveryState(
        phase=phase,
        instance_id=str(control["instance_id"]),
        db_epoch=control["db_epoch"].astimezone(UTC).isoformat(),
        checkpoint_id=checkpoint_id,
        last_sequence=control["last_sequence"],
        records=[
            RecoveryRecord(
                sequence=row["sequence"],
                kind=row["kind"],
                trip_id=str(row["trip_id"]),
                share_id=str(row["share_id"]) if row["share_id"] else None,
                created_at=row["created_at"].astimezone(UTC).isoformat(),
            )
            for row in snapshot["records"]
        ],
    )


def require_prefix(
    older: RecoveryState, newer: RecoveryState, *, same_epoch: bool
) -> None:
    if (
        older.instance_id != newer.instance_id
        or (same_epoch and older.db_epoch != newer.db_epoch)
        or older.last_sequence > newer.last_sequence
        or older.records != newer.records[: older.last_sequence]
    ):
        raise ValueError("RECOVERY_HISTORY_DIVERGED")


def fence_trip(connection: Connection[dict[str, Any]], trip_id: str) -> None:
    trip = connection.execute(
        "SELECT * FROM trips WHERE id=%s FOR UPDATE", (trip_id,)
    ).fetchone()
    if trip is None:
        return
    existing = connection.execute(
        "SELECT * FROM trip_deletion_jobs WHERE trip_id=%s", (trip_id,)
    ).fetchone()
    if existing is not None:
        if existing["status"] != "deleting" or trip["deletion_requested_at"] is None:
            raise ValueError("RECOVERY_DELETION_STATE_INVALID")
        return
    persist_deletion_intent(connection, str(trip["owner_id"]), trip_id)


class RecoveryCoordinator:
    def __init__(self, database: Database, store: RecoveryStore) -> None:
        self.database, self.store = database, store

    def require_target(self) -> None:
        with self.database.transaction() as connection:
            accounting = connection.execute(
                "SELECT EXISTS(SELECT 1 FROM quota_reservations) "
                "OR EXISTS(SELECT 1 FROM quota_daily_totals) "
                "OR EXISTS(SELECT 1 FROM agent_invocations) "
                "OR EXISTS(SELECT 1 FROM model_calls) AS occupied"
            ).fetchone()
            if accounting is None or accounting["occupied"]:
                raise ValueError("RECOVERY_FIXTURE_ONLY_ACCOUNTING_REQUIRED")
            row = connection.execute("SELECT current_database() AS name").fetchone()
            if row is None or not (
                (
                    row["name"] == "dive_trip_demo"
                    and self.database.schema == "workbench_demo"
                )
                or (
                    row["name"] == "postgres"
                    and re.fullmatch(r"python_test_[a-f0-9]{32}", self.database.schema)
                )
            ):
                raise ValueError("RECOVERY_DATABASE_TARGET_REQUIRED")
        require_hosted_schema(self.database)

    def initialize(self) -> None:
        """Only the first deployment's empty DB; never recreate a lost journal."""
        self.require_target()
        with self.store.session() as files:
            if files.read() is not None:
                raise ValueError("RECOVERY_ALREADY_INITIALIZED")
            with self.database.transaction() as connection:
                lock_global(connection)
                occupied = connection.execute(
                    "SELECT EXISTS(SELECT 1 FROM sessions) "
                    "OR EXISTS(SELECT 1 FROM trips) "
                    "OR EXISTS(SELECT 1 FROM planning_executions) AS occupied"
                ).fetchone()
                snapshot = recovery_view(connection)
                if (
                    occupied is None
                    or occupied["occupied"]
                    or snapshot["control"]["last_sequence"]
                ):
                    raise ValueError("RECOVERY_NEW_EMPTY_DATABASE_REQUIRED")
                if snapshot["control"]["recovery_phase"] != "serving":
                    raise ValueError("RECOVERY_MAINTENANCE")
                if snapshot["control"]["recovery_initialized"]:
                    raise ValueError("RECOVERY_ALREADY_INITIALIZED")
                connection.execute(
                    "UPDATE hosted_control SET recovery_initialized=true "
                    "WHERE singleton"
                )
                files.write(project(snapshot, "serving", None))

    def export(self) -> None:
        self.require_target()
        with self.store.session() as files:
            prior = files.read()
            if prior is None or prior.phase != "serving":
                raise ValueError("RECOVERY_MAINTENANCE")
            snapshot = recovery_snapshot(self.database)
            if (
                snapshot["control"]["recovery_phase"] != "serving"
                or not snapshot["control"]["recovery_initialized"]
            ):
                raise ValueError("RECOVERY_MAINTENANCE")
            current = project(snapshot, "serving", prior.checkpoint_id)
            require_prefix(prior, current, same_epoch=True)
            if current != prior:
                files.write(current)

    def require_serving(self) -> None:
        self.require_target()
        with self.store.session() as files:
            prior = files.read()
            if prior is None or prior.phase != "serving":
                raise ValueError("RECOVERY_MAINTENANCE")
            snapshot = recovery_snapshot(self.database)
            if (
                snapshot["control"]["recovery_phase"] != "serving"
                or not snapshot["control"]["recovery_initialized"]
            ):
                raise ValueError("RECOVERY_MAINTENANCE")
            require_prefix(
                prior,
                project(snapshot, "serving", prior.checkpoint_id),
                same_epoch=True,
            )

    def prepare(self) -> str:
        """Freeze decisions in DB before persisting the independent checkpoint."""
        self.require_target()
        with self.store.session() as files:
            prior = files.read()
            if prior is None or prior.phase != "serving":
                raise ValueError("RECOVERY_FRESH_LIVE_CHECKPOINT_REQUIRED")
            with self.database.transaction() as connection:
                lock_global(connection)
                connection.execute(
                    "UPDATE hosted_control SET recovery_phase='maintenance',"
                    "recovery_checkpoint=NULL,recovery_checkpoint_epoch=NULL "
                    "WHERE singleton"
                )
                snapshot = recovery_view(connection)
                if not snapshot["control"]["recovery_initialized"]:
                    raise ValueError("RECOVERY_NOT_INITIALIZED")
                current = project(snapshot, "prepared", str(uuid4()))
                require_prefix(prior, current, same_epoch=True)
            # A failed file write leaves DB fenced, never implicitly reopened.
            files.write(current)
            assert current.checkpoint_id is not None
            return current.checkpoint_id

    def reconcile(self) -> None:
        self.require_target()
        with self.store.session() as files:
            proof = files.read()
            if proof is None or proof.phase not in ("prepared", "reconciled"):
                raise ValueError("RECOVERY_FRESH_LIVE_CHECKPOINT_REQUIRED")
            with self.database.transaction() as connection:
                lock_global(connection)
                connection.execute(
                    "UPDATE hosted_control SET recovery_phase='maintenance' "
                    "WHERE singleton"
                )
                restored_snapshot = recovery_view(connection)
                restored = project(restored_snapshot, "prepared", proof.checkpoint_id)
                if restored.last_sequence <= proof.last_sequence:
                    require_prefix(restored, proof, same_epoch=False)
                    for row in proof.records[restored.last_sequence :]:
                        connection.execute(
                            "INSERT INTO hosted_recovery_journal"
                            "(sequence,kind,trip_id,share_id,created_at) "
                            "VALUES(%s,%s,%s,%s,%s)",
                            (
                                row.sequence,
                                row.kind,
                                row.trip_id,
                                row.share_id,
                                row.created_at,
                            ),
                        )
                    connection.execute(
                        "UPDATE hosted_control SET last_sequence=%s WHERE singleton",
                        (proof.last_sequence,),
                    )
                else:
                    # A retry after the DB commit may include derived expiry intents.
                    control = restored_snapshot["control"]
                    if (
                        str(control["recovery_checkpoint"]) != proof.checkpoint_id
                        or control["recovery_checkpoint_epoch"] != control["db_epoch"]
                    ):
                        raise ValueError("RECOVERY_HISTORY_DIVERGED")
                    require_prefix(
                        proof, restored, same_epoch=proof.phase == "reconciled"
                    )
                for row in proof.records:
                    if row.kind == "delete-trip":
                        fence_trip(connection, row.trip_id)
                    else:
                        connection.execute(
                            "UPDATE trip_shares SET revoked_at=COALESCE(revoked_at,%s) "
                            "WHERE id=%s AND trip_id=%s",
                            (row.created_at, row.share_id, row.trip_id),
                        )
                # Absolute expiries remain authoritative after restoring an older DB.
                connection.execute(
                    "UPDATE hosted_control SET recovery_phase='reconciling' "
                    "WHERE singleton"
                )
                expired = connection.execute(
                    "SELECT t.id FROM trips t JOIN sessions s ON s.id=t.owner_id "
                    "WHERE t.deletion_requested_at IS NULL AND "
                    "LEAST(t.expires_at,s.expires_at)<=clock_timestamp() "
                    "ORDER BY t.id LIMIT 201"
                ).fetchall()
                if len(expired) > 200:
                    raise ValueError("RECOVERY_PRODUCT_CAPACITY_EXCEEDED")
                for candidate in expired:
                    fence_trip(connection, str(candidate["id"]))
                connection.execute(
                    "UPDATE hosted_control SET recovery_phase='maintenance',"
                    "recovery_initialized=true,recovery_checkpoint=%s,"
                    "recovery_checkpoint_epoch=pg_postmaster_start_time() "
                    "WHERE singleton",
                    (proof.checkpoint_id,),
                )
                current = project(
                    recovery_view(connection), "reconciled", proof.checkpoint_id
                )
            files.write(current)

    def finish(self) -> None:
        """Called only after DeletionWorker proved history gone and purged content."""
        self.require_target()
        with self.store.session() as files:
            proof = files.read()
            if proof is None or proof.phase != "reconciled":
                raise ValueError("RECOVERY_RECONCILIATION_REQUIRED")
            with self.database.transaction() as connection:
                lock_global(connection)
                current = project(
                    recovery_view(connection), "reconciled", proof.checkpoint_id
                )
                require_prefix(proof, current, same_epoch=True)
                if current.last_sequence != proof.last_sequence:
                    raise ValueError("RECOVERY_HISTORY_DIVERGED")
                pending = connection.execute(
                    "SELECT EXISTS(SELECT 1 FROM trip_deletion_jobs "
                    "WHERE status='deleting') AS pending"
                ).fetchone()
                if pending is None or pending["pending"]:
                    raise ValueError("RECOVERY_PURGE_PENDING")
                for row in proof.records:
                    table, condition, values = (
                        ("trips", "id=%s", (row.trip_id,))
                        if row.kind == "delete-trip"
                        else (
                            "trip_shares",
                            "id=%s AND trip_id=%s AND revoked_at IS NULL "
                            "AND expires_at>clock_timestamp()",
                            (row.share_id, row.trip_id),
                        )
                    )
                    if connection.execute(
                        f"SELECT 1 FROM {table} WHERE {condition}", values
                    ).fetchone():
                        raise ValueError("RECOVERY_EFFECT_INCOMPLETE")
                if connection.execute(
                    "SELECT 1 FROM trips t JOIN sessions s ON s.id=t.owner_id "
                    "WHERE LEAST(t.expires_at,s.expires_at)<=clock_timestamp() LIMIT 1"
                ).fetchone():
                    raise ValueError("RECOVERY_EXPIRY_PENDING")
                connection.execute(
                    "UPDATE hosted_control SET recovery_phase='serving' WHERE singleton"
                )
            files.write(current.model_copy(update={"phase": "serving"}))
