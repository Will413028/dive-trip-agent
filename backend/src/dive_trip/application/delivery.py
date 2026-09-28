"""Bounded fixture outbox; retries messages, never unknown model invocations."""

import logging

from temporalio.service import RPCError

from dive_trip.modules.planning.evidence import Binding
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError

from .dispatch import WorkflowDelivery


class FixtureDelivery:
    def __init__(self, dispatcher: WorkflowDelivery) -> None:
        self.dispatcher = dispatcher

    def claim(self) -> list[str]:
        # Recheck eligibility when actually delivering. This claim only gives
        # bounded, fair scheduling; it does not authorize any product mutation.
        with self.dispatcher.service.database.transaction() as connection:
            rows = connection.execute(
                """
                WITH due AS (
                  SELECT e.run_id FROM planning_executions e
                  JOIN agent_runs r ON r.id=e.run_id
                  JOIN trips t ON t.id=r.trip_id
                  JOIN sessions s ON s.id=t.owner_id
                  WHERE e.next_delivery_at<=clock_timestamp()
                    AND r.executor='temporal-v1'
                    AND t.deletion_requested_at IS NULL
                    AND t.expires_at>clock_timestamp()
                    AND s.expires_at>clock_timestamp()
                    AND NOT EXISTS (SELECT 1 FROM agent_invocations i
                                    WHERE i.run_id=r.id)
                    AND (((NOT e.workflow_started OR
                           r.lease_expires_at<=clock_timestamp())
                          AND r.status='running') OR
                         (e.committed_receipt IS NOT NULL
                          AND NOT e.decision_delivered AND r.status='succeeded') OR
                         (e.cancellation_requested AND NOT e.cancellation_delivered
                          AND r.status='interrupted'))
                  ORDER BY e.next_delivery_at,e.run_id
                  LIMIT 25 FOR UPDATE OF e SKIP LOCKED
                )
                UPDATE planning_executions e
                SET next_delivery_at=clock_timestamp()+interval '5 seconds'
                FROM due WHERE e.run_id=due.run_id RETURNING e.workflow_id
                """
            ).fetchall()
            return [str(row["workflow_id"]) for row in rows]

    def pending(self, binding: Binding) -> tuple[bool, bool, bool]:
        with self.dispatcher.service.scope(binding, active=False) as (_, row, _):
            return (
                row["status"] == "running"
                and (not row["workflow_started"] or not row["lease_live"]),
                row["status"] == "succeeded" and row["committed_receipt"] is not None,
                row["status"] == "interrupted"
                and row["cancellation_requested"]
                and not row["cancellation_delivered"],
            )

    async def sweep(self) -> None:
        for workflow_id in await run_db(self.claim):
            try:
                binding = await run_db(
                    self.dispatcher.service.worker_binding, workflow_id
                )
                start, decision, cancel = await run_db(self.pending, binding)
                if start:
                    await self.dispatcher.deliver_start(binding)
                elif decision:
                    await self.dispatcher.deliver_decision(binding)
                elif cancel:
                    await self.dispatcher.deliver_cancellation(binding)
            except (DomainError, RPCError, TimeoutError) as error:
                code = (
                    error.code
                    if isinstance(error, DomainError)
                    else type(error).__name__
                )
                logging.getLogger(__name__).warning("WORKFLOW_DELIVERY_RETRY %s", code)
