"""Cross-module retention coordination, using the same durable deletion intent."""

from psycopg import sql

from dive_trip.modules.usage.public import lock_global
from dive_trip.modules.usage.transactions import compact_receipts
from dive_trip.platform import legacy_adk
from dive_trip.platform.database import Database

from .deletion import DeletionService


class RetentionService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.deletions = DeletionService(database)

    def request_expired(self) -> int:
        with self.database.transaction() as connection:
            # This application read model composes module ownership/expiry and
            # executor identity. Actual erasure checks each executor's storage.
            candidates = connection.execute(
                "SELECT t.id,t.owner_id FROM trips t "
                "JOIN sessions s ON s.id=t.owner_id "
                "WHERE t.deletion_requested_at IS NULL "
                "AND LEAST(t.expires_at,s.expires_at)<=clock_timestamp() "
                "ORDER BY LEAST(t.expires_at,s.expires_at),t.id LIMIT 100"
            ).fetchall()
        return sum(
            self.deletions.expire(str(row["owner_id"]), str(row["id"]))
            for row in candidates
        )

    def compact(self) -> dict[str, int]:
        with self.database.transaction() as connection:
            lock_global(connection)
            # Protect unexpected ADK orphans before LIMIT, so they cannot starve
            # later empty owners. The adapter never resumes old executions.
            adk = legacy_adk.namespace(connection)
            owners = connection.execute(
                sql.SQL(
                    "SELECT s.id FROM sessions s "
                    "WHERE s.expires_at<=clock_timestamp() "
                    "AND NOT EXISTS(SELECT 1 FROM trips t WHERE t.owner_id=s.id) "
                    "AND NOT EXISTS(SELECT 1 FROM trip_deletion_jobs j "
                    "WHERE j.owner_id=s.id AND j.status='deleting') {} "
                    "ORDER BY s.expires_at,s.id LIMIT 100 FOR UPDATE"
                ).format(legacy_adk.owner_protection(adk, sql.Identifier("s", "id")))
            ).fetchall()
            for owner in owners:
                legacy_adk.erase_owner_state(connection, adk, str(owner["id"]))
                connection.execute("DELETE FROM sessions WHERE id=%s", (owner["id"],))
            compacted = compact_receipts(connection)
            return {"deletedSessions": len(owners), "compactedReceipts": compacted}
