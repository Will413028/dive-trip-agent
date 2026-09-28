"""Reconcile a persisted run with one stable Temporal workflow identity."""

import asyncio
from datetime import timedelta
from typing import Any, Protocol

import anyio
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from dive_trip.modules.planning.evidence import Binding
from dive_trip.modules.planning.transactions import (
    acknowledge_cancellation,
    acknowledge_decision,
    acknowledge_workflow,
)
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.workflow_lock import workflow_lock

from .planning import PlanningService
from .workflow import TripWorkflow


class AgentDispatcher(Protocol):
    async def start(
        self, owner: str, trip_id: str, request_id: str, message: str, base_version: int
    ) -> Binding: ...
    async def decide(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        *,
        event_request_id: str,
    ) -> dict[str, Any]: ...
    async def cancel(self, binding: Binding) -> None: ...


class WorkflowDelivery:
    def __init__(
        self, service: PlanningService, client: Client, task_queue: str
    ) -> None:
        self.service = service
        self.client = client
        self.task_queue = task_queue

    async def deliver_start(self, binding: Binding) -> None:
        row = await run_db(self.delivery_state, binding)
        if row["status"] != "running":
            return
        if not row["lease_live"]:
            await run_db(self.service.recover, binding, interrupted=True)
            return
        # Lost start ACK may retry this same ID, never create a replacement run.
        async with workflow_lock(self.service.database, row["workflow_id"]):
            # Recheck the deletion fence after acquiring the outbound RPC lock.
            row = await run_db(self.delivery_state, binding)
            if row["status"] != "running":
                return
            if not row["lease_live"]:
                await run_db(self.service.recover, binding, interrupted=True)
                return
            try:
                await self.client.start_workflow(
                    TripWorkflow.run,
                    id=row["workflow_id"],
                    task_queue=self.task_queue,
                    id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                    execution_timeout=timedelta(days=30),
                    rpc_timeout=timedelta(seconds=10),
                )
            except WorkflowAlreadyStartedError:
                pass
        await run_db(self.acknowledge, binding)

    def acknowledge(self, binding: Binding) -> None:
        with self.service.scope(binding, active=False) as (connection, _, _):
            acknowledge_workflow(connection, binding.tripId, binding.runId)

    def delivery_state(self, binding: Binding) -> dict[str, Any]:
        with self.service.scope(binding, active=False) as (_, row, _):
            return row

    async def deliver_decision(self, binding: Binding) -> None:
        row = await run_db(self.delivery_state, binding)
        if row["status"] != "succeeded" or row["committed_receipt"] is None:
            raise DomainError("RUN_STATE_CONFLICT")
        # A failed signal cannot roll back the receipt. Retrying the same decision
        # reuses its immutable result and sends only this wake-up again.
        handle = self.client.get_workflow_handle(f"dive-trip-v1:{binding.runId}")
        try:
            await handle.signal(
                TripWorkflow.decision_committed, rpc_timeout=timedelta(seconds=10)
            )
        except RPCError:
            # A repeat confirmation can arrive after the workflow consumed its
            # receipt and closed. Only confirmed completion needs no wake-up.
            description = await handle.describe(rpc_timeout=timedelta(seconds=5))
            if description.status != WorkflowExecutionStatus.COMPLETED:
                raise
        await run_db(self.acknowledge_decision, binding)

    def acknowledge_decision(self, binding: Binding) -> None:
        with self.service.scope(binding, active=False) as (connection, _, _):
            acknowledge_decision(connection, binding.tripId, binding.runId)

    async def cancel(self, binding: Binding) -> None:
        state = await run_db(self.service.recover, binding, interrupted=True)
        if state["status"] == "interrupted":
            await self.deliver_cancellation(binding)

    async def deliver_cancellation(self, binding: Binding) -> None:
        row = await run_db(self.delivery_state, binding)
        if row["status"] != "interrupted" or not row["cancellation_requested"]:
            raise DomainError("RUN_STATE_CONFLICT")
        # Same outbound lock as start: NOT_FOUND cannot race a later valid start.
        async with workflow_lock(self.service.database, row["workflow_id"]):
            try:
                await self.client.get_workflow_handle(row["workflow_id"]).cancel(
                    rpc_timeout=timedelta(seconds=10)
                )
            except RPCError as error:
                if error.status != RPCStatusCode.NOT_FOUND:
                    raise
        await run_db(self.acknowledge_cancellation, binding)

    def acknowledge_cancellation(self, binding: Binding) -> None:
        with self.service.scope(binding, active=False) as (connection, _, _):
            acknowledge_cancellation(connection, binding.tripId, binding.runId)


class FixtureDispatcher(WorkflowDelivery):
    async def start(
        self, owner: str, trip_id: str, request_id: str, message: str, base_version: int
    ) -> Binding:
        committed: list[Binding] = []

        def persist() -> Binding:
            row, _ = self.service.start(
                owner, trip_id, request_id, message, base_version
            )
            binding = Binding(
                ownerId=owner,
                tripId=trip_id,
                runId=str(row["id"]),
                baseVersion=row["base_version"],
            )
            committed.append(binding)
            return binding

        try:
            binding = await run_db(persist)
            await self.deliver_start(binding)
            return binding
        except asyncio.CancelledError:
            # Cancellation can arrive before start returns its committed ID.
            # run_db drains that transaction; only its successful binding is fenced.
            with anyio.CancelScope(shield=True):
                if committed:
                    await run_db(self.service.recover, committed[0], interrupted=True)
            raise

    async def decide(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        *,
        event_request_id: str,
    ) -> dict[str, Any]:
        committed = await run_db(
            self.service.decide,
            binding,
            interrupt_id,
            accepted,
            event_request_id=event_request_id,
        )
        await self.deliver_decision(binding)
        return committed
