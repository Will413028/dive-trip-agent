"""Durable fixture workflow; confirmation only observes a committed DB receipt."""

import json
from collections.abc import Callable
from datetime import timedelta
from typing import Any, TypedDict

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.workflow import ActivityCancellationType

with workflow.unsafe.imports_passed_through():
    import annotated_types  # noqa: F401
    from pydantic_ai import DeferredToolRequests
    from pydantic_ai.durable_exec.temporal import PydanticAIWorkflow
    from pydantic_ai.usage import UsageLimits

    from dive_trip.modules.planning.answer_contract import AnswerPlan
    from dive_trip.modules.planning.evidence import Binding, Evidence
    from dive_trip.platform.db_async import run_db
    from dive_trip.platform.errors import DomainError

    from .agent_runtime import (
        activity_execution_id,
        activity_service,
        activity_workflow_id,
        agent,
    )


@activity.defn
async def bound_request() -> dict[str, Any]:
    def read() -> dict[str, Any]:
        service = activity_service()
        binding = service.worker_execution(
            activity_workflow_id(), activity_execution_id(), bind=True
        )
        with service.scope(binding) as (_, row, base):
            evidence = Evidence(
                binding=binding,
                kind="requirements",
                origin="bound-snapshot",
                snapshot=base,
            )
            return {
                "binding": binding.model_dump(),
                "request": row["message"],
                "requirements": base.requirements.model_dump(mode="json"),
                "entries": [entry.model_dump(mode="json") for entry in base.entries],
                "requirementsEvidenceRef": evidence.id,
            }

    return await run_db(read)


@activity.defn
async def finish_answer(plan: AnswerPlan) -> dict[str, Any]:
    service = activity_service()
    binding = await run_db(
        service.worker_execution, activity_workflow_id(), activity_execution_id()
    )
    return await run_db(service.finish_answer, binding, plan)


@activity.defn
async def prepare_proposal(call_id: str) -> dict[str, Any]:
    service = activity_service()
    binding = await run_db(
        service.worker_execution, activity_workflow_id(), activity_execution_id()
    )
    return await run_db(service.prepare_proposal, binding, call_id)


@activity.defn
async def committed_receipt() -> dict[str, Any]:
    def read() -> dict[str, Any]:
        service = activity_service()
        binding = service.worker_execution(
            activity_workflow_id(), activity_execution_id()
        )
        with service.scope(binding, active=False) as (_, row, _):
            if row["status"] != "succeeded" or row["committed_receipt"] is None:
                raise DomainError("RUN_STATE_CONFLICT")
            return dict(row["committed_receipt"])

    return await run_db(read)


@activity.defn
async def recover_execution(rejected_activity: str | None) -> dict[str, Any]:
    service = activity_service()
    binding = await run_db(
        service.worker_execution, activity_workflow_id(), activity_execution_id()
    )
    return await run_db(service.recover, binding, rejected_activity=rejected_activity)


ACTIVITIES: list[Callable[..., Any]] = [
    bound_request,
    finish_answer,
    prepare_proposal,
    committed_receipt,
    recover_execution,
]


class ActivityOptions(TypedDict):
    start_to_close_timeout: timedelta
    retry_policy: RetryPolicy
    cancellation_type: ActivityCancellationType


ACTIVITY_OPTIONS: ActivityOptions = {
    "start_to_close_timeout": timedelta(seconds=15),
    "retry_policy": RetryPolicy(maximum_attempts=1),
    "cancellation_type": ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
}


@workflow.defn
class TripWorkflow(PydanticAIWorkflow):
    __pydantic_ai_agents__ = [agent]

    def __init__(self) -> None:
        self.notified = False
        self.awaiting = False

    @workflow.run
    async def run(self) -> dict[str, Any]:
        try:
            return await self.execute()
        except Exception as error:
            rejected_activity = (
                error.activity_id
                if isinstance(error, ActivityError)
                and "model" in error.activity_type
                and isinstance(error.cause, ApplicationError)
                and error.cause.type == "ToolArgumentsRejected"
                else None
            )
            recovered = await workflow.execute_activity(
                recover_execution, rejected_activity, **ACTIVITY_OPTIONS
            )
            if recovered["status"] == "awaiting_confirmation":
                return await self.wait_for_receipt()
            if recovered["status"] == "succeeded":
                if recovered["receipt"] is not None:
                    return dict(recovered["receipt"])
                return dict(recovered["answers"][-1])
            raise ApplicationError("AGENT_FAILED", non_retryable=True) from None

    async def execute(self) -> dict[str, Any]:
        request = await workflow.execute_activity(bound_request, **ACTIVITY_OPTIONS)
        binding = Binding.model_validate(request.pop("binding"))
        result = await agent.run(
            json.dumps(request, ensure_ascii=False),
            deps=binding,
            usage_limits=UsageLimits(request_limit=7, tool_calls_limit=6),
        )
        if isinstance(result.output, DeferredToolRequests):
            deferred = result.output
            if (
                deferred.calls
                or len(deferred.approvals) != 1
                or deferred.approvals[0].tool_name != "propose_changes"
            ):
                raise DomainError("AGENT_CONFIRMATION_BOUNDARY")
            await workflow.execute_activity(
                prepare_proposal, deferred.approvals[0].tool_call_id, **ACTIVITY_OPTIONS
            )
            return await self.wait_for_receipt()
        return await workflow.execute_activity(
            finish_answer, result.output, **ACTIVITY_OPTIONS
        )

    async def wait_for_receipt(self) -> dict[str, Any]:
        self.awaiting = True
        await workflow.wait_condition(lambda: self.notified, timeout=timedelta(days=30))
        return await workflow.execute_activity(committed_receipt, **ACTIVITY_OPTIONS)

    @workflow.signal
    def decision_committed(self) -> None:
        # Signal is only a wake-up. No caller-supplied decision/result is trusted.
        self.notified = True

    @workflow.query
    def awaiting_confirmation(self) -> bool:
        return self.awaiting
