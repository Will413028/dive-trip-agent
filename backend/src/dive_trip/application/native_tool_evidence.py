"""Pinned SDK tool-result evidence, with no argument/result text export."""

import json
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator
from temporalio.api.history.v1 import HistoryEvent

from dive_trip.modules.planning.evidence import Binding
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import WireModel

TOOL_ACTIVITY = "agent__dive_trip_fixture_v1__toolset__<agent>__call_tool"


class CatalogTimeout(WireModel):
    error: Literal["CATALOG_TIMEOUT"]
    items: Annotated[list[Any], Field(max_length=0)]
    retryable: bool

    @model_validator(mode="after")
    def not_retryable(self) -> Self:
        if self.retryable:
            raise ValueError("FAULT_RETRY_NOT_ALLOWED")
        return self


def native_catalog_faults(events: list[HistoryEvent], binding: Binding) -> list[str]:
    scheduled: dict[int, tuple[str, str]] = {}
    started: dict[int, int] = {}
    finished: set[int] = set()
    faults: list[str] = []
    try:
        for event in events:
            if event.HasField("activity_task_scheduled_event_attributes"):
                value = event.activity_task_scheduled_event_attributes
                if value.activity_type.name != TOOL_ACTIVITY:
                    continue
                if value.retry_policy.maximum_attempts != 1:
                    raise ValueError("TOOL_RETRY_POLICY")
                payloads = value.input.payloads
                if len(payloads) != 2 or any(
                    p.metadata.get("encoding") != b"json/plain" for p in payloads
                ):
                    raise ValueError("TOOL_PAYLOAD")
                params = json.loads(payloads[0].data)
                deps = Binding.model_validate_json(payloads[1].data)
                name = params["name"]
                call_id = params["serialized_run_context"]["tool_call_id"]
                if deps != binding or type(name) is not str or type(call_id) is not str:
                    raise ValueError("TOOL_BINDING")
                scheduled[event.event_id] = (name, call_id)
            elif event.HasField("activity_task_started_event_attributes"):
                start = event.activity_task_started_event_attributes
                if start.scheduled_event_id in scheduled:
                    if start.attempt != 1 or start.scheduled_event_id in started:
                        raise ValueError("TOOL_REDISPATCH")
                    started[start.scheduled_event_id] = event.event_id
            elif event.HasField("activity_task_completed_event_attributes"):
                completed = event.activity_task_completed_event_attributes
                tool = scheduled.get(completed.scheduled_event_id)
                if tool is None:
                    continue
                if (
                    completed.scheduled_event_id in finished
                    or completed.started_event_id
                    != started.get(completed.scheduled_event_id)
                ):
                    raise ValueError("TOOL_COMPLETION_BINDING")
                finished.add(completed.scheduled_event_id)
                payloads = completed.result.payloads
                if (
                    len(payloads) != 1
                    or payloads[0].metadata.get("encoding") != b"json/plain"
                ):
                    raise ValueError("TOOL_RESULT")
                result = json.loads(payloads[0].data)
                content = result.get("result")
                if (
                    isinstance(content, dict)
                    and content.get("error") == "CATALOG_TIMEOUT"
                ):
                    if tool[0] != "find_items" or result.get("kind") != "tool_return":
                        raise ValueError("TOOL_FAULT_BINDING")
                    CatalogTimeout.model_validate(content)
                    faults.append(tool[1])
        if len(faults) > 6 or len(set(faults)) != len(faults):
            raise ValueError("TOOL_FAULT_INVENTORY")
        # Independent tools may finish in either order; model declaration order
        # is checked separately. The fault inventory is an exact set of call IDs.
        return sorted(faults)
    except (ValueError, KeyError, TypeError, AttributeError):
        raise DomainError("TEMPORAL_TOOL_EVIDENCE_INVALID") from None
