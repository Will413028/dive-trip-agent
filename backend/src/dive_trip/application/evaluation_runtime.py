"""Owned evaluation worker phases; the outer controller owns authorization.

No public configuration or credential discovery lives here. Construct only in
the isolated evaluator; ordinary API launchers use FixtureDispatcher.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import anyio
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode
from temporalio.worker import Worker

from dive_trip.modules.planning.evidence import Binding
from dive_trip.modules.usage.provider import maximum_cost
from dive_trip.modules.usage.public import Policy
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer

from .admission import AdmissionService
from .agent_runtime import Generation, bind_receipt_worker_service, bind_worker_service
from .dispatch import WorkflowDelivery
from .planning import PlanningService
from .temporal_evidence import TemporalEvidence, read_temporal_evidence
from .usage_audit import UsageAudit, reconcile_usage
from .usage_evidence import UsageEvidence, read_usage_evidence
from .workflow import ACTIVITIES, TripWorkflow

SDK_CLOSE_SECONDS = 15


class OwnedGeneration(Generation, Protocol):
    async def aclose(self) -> None: ...


class EvaluationDispatcher(WorkflowDelivery):
    def __init__(
        self,
        service: PlanningService,
        admission: AdmissionService,
        client: Client,
        task_queue: str,
        *,
        policy: Policy,
        peer: EvaluationLoopbackPeer,
        load_generation: Callable[[], Awaitable[OwnedGeneration]],
    ) -> None:
        if (
            service.accounting is None
            or re.fullmatch(r"python_test_[a-f0-9]{32}", service.database.schema)
            is None
            or admission.database is not service.database
        ):
            raise DomainError("EVALUATION_CONTEXT_REQUIRED")
        super().__init__(service, client, task_queue)
        self.provider = service.accounting.provider
        self.admission = admission
        self.policy, self.peer = policy, peer
        self.load_generation = load_generation
        self.phase: asyncio.Task[None] | None = None
        self.binding: Binding | None = None
        self.before: tuple[UsageEvidence, TemporalEvidence] | None = None
        self.operation_lock = asyncio.Lock()
        self.unverified_cleanup = False

    async def start(
        self, owner: str, trip_id: str, request_id: str, message: str, base_version: int
    ) -> Binding:
        async with asyncio.timeout(55), self.operation_lock:
            return await self._start(owner, trip_id, request_id, message, base_version)

    async def _start(
        self, owner: str, trip_id: str, request_id: str, message: str, base_version: int
    ) -> Binding:
        await self.join()
        committed: list[Binding] = []

        def admit() -> tuple[Binding, bool]:
            now = datetime.now(UTC)
            ip_key, previous_ip_key = self.peer.keys(now)
            binding, _, created = self.admission.start(
                owner,
                trip_id,
                request_id,
                message,
                base_version,
                self.provider,
                ip_key,
                maximum_cost(self.provider.provider),
                now,
                self.policy,
                previous_ip_key=previous_ip_key,
            )
            committed.append(binding)
            return binding, created

        generation: OwnedGeneration | None = None
        try:
            binding, created = await run_db(admit)
            if not created:
                return binding
            self.binding, self.before = binding, None
            # Admission/claim commits before the credential-bearing factory runs.
            async with asyncio.timeout(30):
                generation = await self.load_generation()
            if generation.provider != self.provider:
                raise DomainError("PROVIDER_CONFLICT")
            ready = asyncio.get_running_loop().create_future()
            self.phase = asyncio.create_task(
                self.worker_phase(binding, generation, ready)
            )
            generation = None  # The worker phase now owns SDK cleanup.
            await ready
            await self.deliver_start(binding)
            return binding
        except BaseException:
            with anyio.CancelScope(shield=True):
                try:
                    if committed:
                        await self.cancel(committed[0])
                except BaseException:
                    self.unverified_cleanup = True
                    raise
                finally:
                    if generation is not None:
                        await self.close_generation(generation)
            raise

    async def decide(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        *,
        event_request_id: str,
    ) -> dict[str, Any]:
        async with asyncio.timeout(55), self.operation_lock:
            return await self._decide(
                binding, interrupt_id, accepted, event_request_id=event_request_id
            )

    async def _decide(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        *,
        event_request_id: str,
    ) -> dict[str, Any]:
        if self.binding != binding:
            raise DomainError("EVALUATION_RUN_BINDING")
        await self.join()
        if self.before is None:
            self.before = await self.evidence(binding)
        now = datetime.now(UTC)
        ip_key, previous_ip_key = self.peer.keys(now)
        committed = await run_db(
            self.admission.resume,
            binding,
            interrupt_id,
            accepted,
            self.provider,
            ip_key,
            now,
            self.policy,
            previous_ip_key=previous_ip_key,
            event_request_id=event_request_id,
        )
        ready = asyncio.get_running_loop().create_future()
        # No credential loader or Generation object enters the receipt worker.
        self.phase = asyncio.create_task(self.worker_phase(binding, None, ready))
        await ready
        await self.deliver_decision(binding)
        return committed

    async def worker_phase(
        self,
        binding: Binding,
        generation: OwnedGeneration | None,
        ready: asyncio.Future[None],
    ) -> None:
        try:
            scope = (
                bind_worker_service(self.service, generation)
                if generation is not None
                else bind_receipt_worker_service(self.service)
            )
            with scope:
                async with Worker(
                    self.client,
                    task_queue=self.task_queue,
                    workflows=[TripWorkflow],
                    activities=ACTIVITIES,
                ):
                    if not ready.done():
                        ready.set_result(None)
                    async with asyncio.timeout(90):
                        await self.wait_checkpoint(binding)
        except BaseException as error:
            if not ready.done():
                ready.set_exception(error)
            raise
        finally:
            if generation is not None:
                with anyio.CancelScope(shield=True):
                    await self.close_generation(generation)

    async def close_generation(self, generation: OwnedGeneration) -> None:
        try:
            async with asyncio.timeout(SDK_CLOSE_SECONDS):
                await generation.aclose()
        except BaseException:
            self.unverified_cleanup = True
            raise

    async def wait_checkpoint(self, binding: Binding) -> None:
        while True:
            row = await run_db(self.delivery_state, binding)
            if row["status"] != "running":
                try:
                    description = await self.client.get_workflow_handle(
                        row["workflow_id"],
                        run_id=(
                            str(row["execution_run_id"])
                            if row["execution_run_id"] is not None
                            else None
                        ),
                    ).describe(rpc_timeout=timedelta(seconds=5))
                except RPCError as error:
                    if error.status == RPCStatusCode.NOT_FOUND:
                        return
                    raise
                if description.status != WorkflowExecutionStatus.RUNNING:
                    return
                if row["status"] == "awaiting_confirmation":
                    try:
                        await self.evidence(binding)
                        return
                    except DomainError as error:
                        if error.code not in (
                            "TEMPORAL_CHECKPOINT_NOT_READY",
                            "TEMPORAL_EVIDENCE_NOT_CLOSED",
                        ):
                            raise
            await asyncio.sleep(0.05)

    async def join(self) -> None:
        if self.unverified_cleanup:
            raise DomainError("EVALUATION_DRAIN_UNVERIFIED")
        if self.phase is not None:
            # A timeout does not cancel a worker or manufacture drain evidence.
            async with asyncio.timeout(45):
                await asyncio.shield(self.phase)

    async def evidence(
        self, binding: Binding
    ) -> tuple[UsageEvidence, TemporalEvidence]:
        usage = await run_db(
            read_usage_evidence, self.service.database, binding, self.provider
        )
        native = await read_temporal_evidence(self.client, usage)
        return usage, native

    async def capture(
        self, binding: Binding
    ) -> tuple[UsageEvidence, TemporalEvidence, UsageAudit]:
        async with asyncio.timeout(55), self.operation_lock:
            return await self._capture(binding)

    async def _capture(
        self, binding: Binding
    ) -> tuple[UsageEvidence, TemporalEvidence, UsageAudit]:
        if self.binding != binding:
            raise DomainError("EVALUATION_RUN_BINDING")
        await self.join()
        usage, native = await self.evidence(binding)
        return usage, native, reconcile_usage(usage, native, previous=self.before)
