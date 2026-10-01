"""Persistent purge intent; external history deletion precedes content commit."""

import logging
import re
from datetime import timedelta
from typing import Any

from psycopg import Connection
from temporalio.api.common.v1 import WorkflowExecution
from temporalio.api.enums.v1 import ArchivalState
from temporalio.api.workflowservice.v1 import (
    DeleteWorkflowExecutionRequest,
    DescribeNamespaceRequest,
)
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode

from dive_trip.modules.identity.public import owner_expiry, require_owner
from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.trips import transactions as trips
from dive_trip.modules.usage import transactions as usage
from dive_trip.modules.usage.public import lock_global
from dive_trip.platform import legacy_adk
from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.workflow_lock import workflow_lock


def persist_deletion_intent(
    connection: Connection[dict[str, Any]], owner: str, trip_id: str
) -> None:
    """Caller owns authorization/expiry and locks; all paths share the same fence."""
    rows = planning.deletion_runs(connection, trip_id)
    planning.fence_deletion(connection, trip_id)
    trips.deletion.request(
        connection,
        owner,
        trip_id,
        [row["workflow_id"] for row in rows if row["executor"] == "temporal-v1"],
    )


class DeletionService:
    def __init__(self, database: Database) -> None:
        if database.schema != "workbench_demo" and not re.fullmatch(
            r"(?:python_test|e2e)_[a-f0-9]{32}", database.schema
        ):
            raise DomainError("RETENTION_TARGET_DISABLED")
        self.database = database

    def request(self, owner: str, trip_id: str) -> dict[str, Any]:
        trips.valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, owner, exclusive=True)
            existing = trips.deletion.find(connection, owner, trip_id)
            if existing is not None:
                return {"status": existing["status"]}
            trips.get_trip(connection, owner, trip_id, lock=True)
            persist_deletion_intent(connection, owner, trip_id)
            require_owner(connection, owner)
            return {"status": "deleting"}

    def status(self, owner: str, trip_id: str) -> dict[str, Any]:
        trips.valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            row = trips.deletion.find(connection, owner, trip_id)
            if row is None:
                raise DomainError("NOT_FOUND")
            return {"status": row["status"]}

    def expire(self, owner: str, trip_id: str) -> bool:
        """Internal clock-driven intent, never exposed as an HTTP authority."""
        with self.database.transaction() as connection:
            lock_global(connection)
            connection.execute(
                "SELECT id FROM sessions WHERE id=%s FOR UPDATE", (owner,)
            )
            connection.execute(
                "SELECT id FROM trips WHERE id=%s FOR UPDATE", (trip_id,)
            )
            expired = connection.execute(
                "SELECT t.id FROM trips t JOIN sessions s ON s.id=t.owner_id "
                "WHERE t.id=%s AND t.owner_id=%s AND t.deletion_requested_at IS NULL "
                "AND LEAST(t.expires_at,s.expires_at)<=clock_timestamp()",
                (trip_id, owner),
            ).fetchone()
            if expired is None:
                return False
            persist_deletion_intent(connection, owner, trip_id)
            return True

    def pending(self) -> list[str]:
        with self.database.transaction() as connection:
            return trips.deletion.pending(connection)

    def job(self, trip_id: str) -> dict[str, Any]:
        with self.database.transaction() as connection:
            return trips.deletion.job(connection, trip_id)

    def attempted(self, trip_id: str) -> None:
        with self.database.transaction() as connection:
            trips.deletion.attempted(connection, trip_id)

    def prune_receipts(self) -> int:
        with self.database.transaction() as connection:
            count = 0
            for row in trips.deletion.completed_candidates(connection):
                trip_id = str(row["trip_id"])
                try:
                    expiry = owner_expiry(connection, str(row["owner_id"]))
                except DomainError as error:
                    if error.code != "NOT_FOUND":
                        raise
                    count += trips.deletion.prune_receipt(connection, trip_id)
                else:
                    # Session expiry is fixed at creation; live receipts do not
                    # repeatedly occupy the head of the bounded cleanup batch.
                    trips.deletion.defer_receipt_check(connection, trip_id, expiry)
            return count

    def complete(self, trip_id: str) -> None:
        with self.database.transaction() as connection:
            lock_global(connection)
            job = trips.deletion.job(connection, trip_id)
            if job["status"] == "deleted":
                return
            # Expired owners must not prevent an already authorized purge.
            # Writers require a live, non-tombstoned trip and cannot re-enter.
            rows = planning.deletion_runs(connection, trip_id)
            legacy_adk.erase_runs(
                connection,
                str(job["owner_id"]),
                [str(row["id"]) for row in rows if row["executor"] == "adk"],
            )
            usage.erase_runs(
                connection, str(job["owner_id"]), [str(row["id"]) for row in rows]
            )
            trips.deletion.complete(connection, trip_id)


class DeletionWorker:
    def __init__(self, service: DeletionService, client: Client) -> None:
        self.service, self.client = service, client

    async def purge(self, trip_id: str) -> None:
        async with workflow_lock(self.service.database, f"delete:{trip_id}"):
            job = await run_db(self.service.job, trip_id)
            if job["status"] == "deleted":
                return
            await run_db(self.service.attempted, trip_id)
            namespace = await self.client.workflow_service.describe_namespace(
                DescribeNamespaceRequest(namespace=self.client.namespace),
                timeout=timedelta(seconds=5),
                retry=False,
            )
            if (
                namespace.config.history_archival_state
                != ArchivalState.ARCHIVAL_STATE_DISABLED
                or namespace.config.visibility_archival_state
                != ArchivalState.ARCHIVAL_STATE_DISABLED
            ):
                raise DomainError("ARCHIVED_HISTORY_REQUIRES_PURGE")
            for workflow_id in job["workflow_ids"]:
                async with workflow_lock(self.service.database, workflow_id):
                    try:
                        await self.client.workflow_service.delete_workflow_execution(
                            DeleteWorkflowExecutionRequest(
                                namespace=self.client.namespace,
                                workflow_execution=WorkflowExecution(
                                    workflow_id=workflow_id
                                ),
                            ),
                            timeout=timedelta(seconds=10),
                            retry=False,
                        )
                    except RPCError as error:
                        if error.status != RPCStatusCode.NOT_FOUND:
                            raise
                    # ACK alone is not proof that history is no longer readable.
                    try:
                        await self.client.get_workflow_handle(workflow_id).describe(
                            rpc_timeout=timedelta(seconds=5)
                        )
                    except RPCError as error:
                        if error.status != RPCStatusCode.NOT_FOUND:
                            raise
                    else:
                        raise DomainError("DELETION_PENDING")
                    try:
                        await self.client.get_workflow_handle(
                            workflow_id
                        ).fetch_history(rpc_timeout=timedelta(seconds=5))
                    except RPCError as error:
                        if error.status != RPCStatusCode.NOT_FOUND:
                            raise
                    else:
                        raise DomainError("DELETION_PENDING")
            await run_db(self.service.complete, trip_id)

    async def sweep(self) -> dict[str, int]:
        completed, pending = 0, 0
        for trip_id in await run_db(self.service.pending):
            try:
                await self.purge(trip_id)
                completed += 1
            except (RPCError, DomainError) as error:
                logging.getLogger(__name__).warning(
                    "DELETION_RETRY %s",
                    error.code if isinstance(error, DomainError) else error.status.name,
                )
                pending += 1
        receipts = await run_db(self.service.prune_receipts)
        return {"deleted": completed, "pending": pending, "prunedReceipts": receipts}
