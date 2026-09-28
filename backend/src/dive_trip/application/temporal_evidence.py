"""Bounded private native-history audit for closed isolated executions."""

import asyncio
from datetime import timedelta
from typing import Literal

from pydantic import Field, TypeAdapter
from pydantic_ai.messages import ModelResponse, ToolCallPart
from temporalio.api.history.v1 import HistoryEvent
from temporalio.client import Client, WorkflowExecutionStatus

from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import NonnegativeInt, WireModel

from .decision_evidence import CommittedDecision
from .native_tool_evidence import native_catalog_faults
from .usage_evidence import UsageEvidence

MODEL_ACTIVITY = "agent__dive_trip_fixture_v1__model_request"
MAX_EVENTS = 2048
MAX_HISTORY_BYTES = 8 * 1024 * 1024
TERMINALS = {
    "workflow_execution_completed_event_attributes": "completed",
    "workflow_execution_failed_event_attributes": "failed",
    "workflow_execution_canceled_event_attributes": "canceled",
    "workflow_execution_terminated_event_attributes": "terminated",
    "workflow_execution_timed_out_event_attributes": "timed_out",
}
ActivityOutcome = Literal["completed", "failed", "canceled", "timed_out"]
ACTIVITY_TERMINALS: dict[str, ActivityOutcome] = {
    "activity_task_completed_event_attributes": "completed",
    "activity_task_failed_event_attributes": "failed",
    "activity_task_canceled_event_attributes": "canceled",
    "activity_task_timed_out_event_attributes": "timed_out",
}


class NativeModelEvidence(WireModel):
    activity_id: str
    scheduled_event_id: NonnegativeInt
    started_event_id: NonnegativeInt | None
    terminal: ActivityOutcome | None
    pre_dispatch_rejected: bool = False
    tool_calls: list[tuple[str, str]] | None = Field(default=None, max_length=6)


class TemporalEvidence(WireModel):
    namespace: str
    workflow_id: str
    execution_run_id: str
    terminal: str
    event_count: NonnegativeInt
    models: list[NativeModelEvidence] = Field(max_length=7)
    catalog_fault_calls: list[str] = Field(max_length=6)


def audit_history(
    events: list[HistoryEvent],
    evidence: UsageEvidence,
    *,
    namespace: str,
    execution_run_id: str,
) -> TemporalEvidence:
    def reject() -> None:
        raise DomainError("TEMPORAL_EVIDENCE_INVALID")

    if (
        evidence.execution_run_id != execution_run_id
        or not events
        or len(events) > MAX_EVENTS
        or sum(event.ByteSize() for event in events) > MAX_HISTORY_BYTES
        or [event.event_id for event in events] != list(range(1, len(events) + 1))
        or not events[0].HasField("workflow_execution_started_event_attributes")
    ):
        reject()
    start = events[0].workflow_execution_started_event_attributes
    if (
        start.workflow_type.name != "TripWorkflow"
        or start.attempt != 1
        or start.continued_execution_run_id
        or start.original_execution_run_id != execution_run_id
    ):
        reject()
    terminal = TERMINALS.get(events[-1].WhichOneof("attributes") or "")
    if terminal is not None and evidence.status == "awaiting_confirmation":
        reject()
    if terminal is None:
        if evidence.status != "awaiting_confirmation":
            reject()
        audit_waiting_checkpoint(events)
        terminal = "awaiting_confirmation"
    models: dict[int, NativeModelEvidence] = {}
    for event in events:
        if event.HasField("activity_task_scheduled_event_attributes"):
            scheduled = event.activity_task_scheduled_event_attributes
            name = scheduled.activity_type.name
            if "__model_" in name and name != MODEL_ACTIVITY:
                reject()
            if name != MODEL_ACTIVITY:
                continue
            if scheduled.retry_policy.maximum_attempts != 1:
                reject()
            models[event.event_id] = NativeModelEvidence(
                activity_id=scheduled.activity_id,
                scheduled_event_id=event.event_id,
                started_event_id=None,
                terminal=None,
            )
        elif event.HasField("activity_task_started_event_attributes"):
            started = event.activity_task_started_event_attributes
            model = models.get(started.scheduled_event_id)
            if model is not None:
                if started.attempt != 1 or model.started_event_id is not None:
                    reject()
                model.started_event_id = event.event_id
        else:
            field = event.WhichOneof("attributes") or ""
            outcome = ACTIVITY_TERMINALS.get(field)
            if outcome is not None:
                attributes = getattr(event, field)
                model = models.get(attributes.scheduled_event_id)
                if model is not None:
                    if model.terminal is not None or attributes.started_event_id != (
                        model.started_event_id or 0
                    ):
                        reject()
                    model.terminal = outcome
                    if outcome == "completed":
                        payloads = attributes.result.payloads
                        if (
                            len(payloads) != 1
                            or payloads[0].metadata.get("encoding") != b"json/plain"
                        ):
                            reject()
                        try:
                            response = TypeAdapter(ModelResponse).validate_json(
                                payloads[0].data
                            )
                        except ValueError:
                            raise DomainError("TEMPORAL_MODEL_RESULT_INVALID") from None
                        if not response.parts or any(
                            not isinstance(part, ToolCallPart)
                            for part in response.parts
                        ):
                            reject()
                        model.tool_calls = [
                            (part.tool_call_id, part.tool_name)
                            for part in response.parts
                            if isinstance(part, ToolCallPart)
                        ]
                    if outcome == "failed":
                        failure = attributes.failure
                        model.pre_dispatch_rejected = (
                            failure.HasField("application_failure_info")
                            and failure.application_failure_info.type
                            == "ModelDispatchNotStarted"
                            and failure.message == "MODEL_DISPATCH_NOT_STARTED"
                        )
    by_id = {model.activity_id: model for model in models.values()}
    if terminal == "awaiting_confirmation" and (
        any(model.terminal != "completed" for model in by_id.values())
        or any(not tool.completed for tool in evidence.tools)
    ):
        reject()
    calls = {call.event.callId: call for call in evidence.calls}
    steps = {step.activity_id: step for step in evidence.steps}
    if len(by_id) != len(models) or len(models) > 7 or not set(calls) <= set(by_id):
        reject()
    if [key for key in by_id if key in calls] != [
        step.activity_id for step in evidence.steps
    ]:
        reject()
    for key, model in by_id.items():
        if model.pre_dispatch_rejected and key in calls:
            reject()
        if (
            model.started_event_id is not None
            and key not in calls
            and not model.pre_dispatch_rejected
        ):
            reject()
        if key in calls and model.started_event_id is None:
            reject()
        if model.terminal == "completed" and (
            key not in steps
            or not steps[key].completed
            or calls[key].status != "completed"
        ):
            reject()
    # Failed/unknown results must not manufacture a successful tool count.
    declared = [call for model in by_id.values() for call in model.tool_calls or []]
    expected: list[tuple[str, str]] = [
        (tool.call_id, tool.name) for tool in evidence.tools
    ]
    if evidence.final_call_id is not None:
        expected.append((evidence.final_call_id, "final_answer"))
    if declared != expected[: len(declared)] or (
        all(model.terminal == "completed" for model in by_id.values())
        and declared != expected
    ):
        reject()
    if evidence.decision is not None:
        if terminal != "completed":
            reject()
        payloads = events[
            -1
        ].workflow_execution_completed_event_attributes.result.payloads
        if len(payloads) != 1 or payloads[0].metadata.get("encoding") != b"json/plain":
            reject()
        try:
            native_result = CommittedDecision.model_validate_json(payloads[0].data)
        except (ValueError, UnicodeError):
            raise DomainError("TEMPORAL_DECISION_INVALID") from None
        if native_result != evidence.decision:
            reject()
    faults = native_catalog_faults(events, evidence.run)
    if faults != sorted(
        tool.call_id for tool in evidence.tools if tool.fault is not None
    ):
        reject()
    return TemporalEvidence(
        namespace=namespace,
        workflow_id=f"dive-trip-v1:{evidence.run.runId}",
        execution_run_id=execution_run_id,
        terminal=str(terminal),
        event_count=len(events),
        models=list(models.values()),
        catalog_fault_calls=faults,
    )


def audit_waiting_checkpoint(events: list[HistoryEvent]) -> None:
    """A paused workflow checkpoint, not physical worker-drain evidence."""
    pending_activities: set[int] = set()
    pending_tasks: set[int] = set()
    timers: set[str] = set()
    for event in events:
        field = event.WhichOneof("attributes") or ""
        if not field:
            raise DomainError("TEMPORAL_CHECKPOINT_CONFLICT")
        attributes = getattr(event, field)
        if field in TERMINALS or field in (
            "workflow_execution_signaled_event_attributes",
            "workflow_execution_cancel_requested_event_attributes",
            "workflow_execution_continued_as_new_event_attributes",
        ):
            raise DomainError("TEMPORAL_CHECKPOINT_CONFLICT")
        if field == "activity_task_scheduled_event_attributes":
            pending_activities.add(event.event_id)
        elif field in ACTIVITY_TERMINALS:
            if attributes.scheduled_event_id not in pending_activities:
                raise DomainError("TEMPORAL_CHECKPOINT_CONFLICT")
            pending_activities.remove(attributes.scheduled_event_id)
        elif field == "workflow_task_scheduled_event_attributes":
            pending_tasks.add(event.event_id)
        elif field in (
            "workflow_task_completed_event_attributes",
            "workflow_task_failed_event_attributes",
            "workflow_task_timed_out_event_attributes",
        ):
            if attributes.scheduled_event_id not in pending_tasks:
                raise DomainError("TEMPORAL_CHECKPOINT_CONFLICT")
            pending_tasks.remove(attributes.scheduled_event_id)
        elif field == "timer_started_event_attributes":
            timers.add(attributes.timer_id)
        elif field in (
            "timer_canceled_event_attributes",
            "timer_fired_event_attributes",
        ):
            timers.discard(attributes.timer_id)
    if pending_activities or pending_tasks or len(timers) != 1:
        raise DomainError("TEMPORAL_CHECKPOINT_NOT_READY")


async def read_temporal_evidence(
    client: Client, evidence: UsageEvidence
) -> TemporalEvidence:
    """No payload export; a native checkpoint never proves physical worker drain."""
    async with asyncio.timeout(15):
        if evidence.execution_run_id is None:
            raise DomainError("TEMPORAL_EXECUTION_UNBOUND")
        handle = client.get_workflow_handle(
            f"dive-trip-v1:{evidence.run.runId}", run_id=evidence.execution_run_id
        )
        description = await handle.describe(rpc_timeout=timedelta(seconds=5))
        if description.run_id != evidence.execution_run_id:
            raise DomainError("TEMPORAL_EXECUTION_CONFLICT")
        if description.status in (None, WorkflowExecutionStatus.CONTINUED_AS_NEW) or (
            description.status == WorkflowExecutionStatus.RUNNING
            and evidence.status != "awaiting_confirmation"
        ):
            raise DomainError("TEMPORAL_EVIDENCE_NOT_CLOSED")
        pinned = client.get_workflow_handle(handle.id, run_id=description.run_id)
        events: list[HistoryEvent] = []
        size = 0
        async for event in pinned.fetch_history_events(
            page_size=128, skip_archival=True, rpc_timeout=timedelta(seconds=5)
        ):
            size += event.ByteSize()
            if len(events) >= MAX_EVENTS or size > MAX_HISTORY_BYTES:
                raise DomainError("TEMPORAL_EVIDENCE_TOO_LARGE")
            events.append(event)
        return audit_history(
            events,
            evidence,
            namespace=client.namespace,
            execution_run_id=description.run_id,
        )
