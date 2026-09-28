"""Durable runtime binding: never attach a product schema to fresh empty history."""

from datetime import timedelta
from uuid import UUID

from temporalio.api.enums.v1 import ArchivalState
from temporalio.api.workflowservice.v1 import (
    DescribeNamespaceRequest,
    GetClusterInfoRequest,
)
from temporalio.client import Client

from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError


async def bind_temporal(database: Database, client: Client) -> None:
    cluster = await client.workflow_service.get_cluster_info(
        GetClusterInfoRequest(), timeout=timedelta(seconds=5), retry=False
    )
    namespace = await client.workflow_service.describe_namespace(
        DescribeNamespaceRequest(namespace=client.namespace),
        timeout=timedelta(seconds=5),
        retry=False,
    )
    if (
        namespace.config.history_archival_state != ArchivalState.ARCHIVAL_STATE_DISABLED
        or namespace.config.visibility_archival_state
        != ArchivalState.ARCHIVAL_STATE_DISABLED
    ):
        raise DomainError("ARCHIVED_HISTORY_REQUIRES_PURGE")
    identity = (
        UUID(cluster.cluster_id),
        UUID(namespace.namespace_info.id),
        client.namespace,
    )

    def bind() -> None:
        with database.transaction() as connection:
            connection.execute(
                "SELECT pg_advisory_xact_lock(724923,hashtext(current_schema()))"
            )
            existing = connection.execute(
                "SELECT * FROM temporal_service_binding"
            ).fetchone()
            if existing is not None:
                if (
                    existing["cluster_id"],
                    existing["namespace_id"],
                    existing["namespace"],
                ) != identity:
                    raise DomainError("TEMPORAL_SERVICE_MISMATCH")
                return
            if connection.execute(
                "SELECT 1 FROM planning_executions LIMIT 1"
            ).fetchone():
                raise DomainError("TEMPORAL_BINDING_REQUIRED_BEFORE_EXECUTION")
            connection.execute(
                "INSERT INTO temporal_service_binding"
                "(cluster_id,namespace_id,namespace) "
                "VALUES(%s,%s,%s)",
                identity,
            )

    await run_db(bind)
