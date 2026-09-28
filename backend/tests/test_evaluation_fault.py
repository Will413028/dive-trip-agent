import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_admission import setup, start

from dive_trip.application import agent_runtime
from dive_trip.application.admission import AdmissionService
from dive_trip.application.agent_runtime import SyntheticGeneration, bind_worker_service
from dive_trip.application.native_tool_evidence import TOOL_ACTIVITY
from dive_trip.application.planning import PlanningService
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.temporal_evidence import (
    audit_history,
    read_temporal_evidence,
)
from dive_trip.application.usage_audit import reconcile_usage
from dive_trip.application.usage_evidence import read_usage_evidence
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.usage.provider import GEMINI_MODEL, ProviderBinding
from dive_trip.platform.errors import DomainError


@pytest.mark.parametrize("parallel", [False, True])
async def test_catalog_fault_is_bound_before_worker_and_never_creates_items_evidence(
    database, monkeypatch, parallel
):
    identity, trip, _, catalog = setup(database)
    admission = AdmissionService(database, catalog, evaluation_fault="catalog-timeout")
    binding, _, _ = start(admission, identity, trip)
    # Request idempotency includes the persisted server-selected fault context.
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        start(AdmissionService(database, catalog), identity, trip)
    assert start(admission, identity, trip)[2] is False
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(database, [], accounting=RuntimeAccounting(provider))
    observed = []
    fault_ids = ["z-fault-read", "a-fault-read"] if parallel else ["fault-read"]

    async def scenario(messages, _info):
        returns = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if not returns:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "find_items",
                        {"destinationId": "xiaoliuqiu"},
                        tool_call_id=call_id,
                    )
                    for call_id in fault_ids
                ]
            )
        observed.extend(part.content for part in returns)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_answer",
                    {
                        "version": "1",
                        "answer": {"kind": "clarify", "fields": ["people"]},
                    },
                    tool_call_id="fault-final",
                )
            ]
        )

    monkeypatch.setattr(agent_runtime, "fixture_response", scenario)
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"catalog-fault-{uuid4().hex}"
        with bind_worker_service(
            service, SyntheticGeneration(provider, "synthetic-not-a-real-key")
        ):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                handle = await environment.client.start_workflow(
                    TripWorkflow.run,
                    id=f"dive-trip-v1:{binding.runId}",
                    task_queue=queue,
                    execution_timeout=timedelta(seconds=60),
                )
                async with asyncio.timeout(30):
                    await handle.result()
        assert observed == [
            {"error": "CATALOG_TIMEOUT", "items": [], "retryable": False}
        ] * len(fault_ids)
        evidence = read_usage_evidence(database, binding, provider)
        native = await read_temporal_evidence(environment.client, evidence)
        assert native.terminal == "completed"
        assert native.catalog_fault_calls == sorted(fault_ids)
        assert reconcile_usage(evidence, native).faultObserved == "catalog-timeout"
        with service.scope(binding, active=False) as (connection, row, base):
            from dive_trip.modules.planning import transactions as planning

            values = service.evidence(
                binding, base, row, planning.tool_calls(connection, binding.runId)
            )
            assert all(value.kind != "items" for value in values)
        for mutation in ("missing", "retryable-number", "wrong-tool", "wrong-owner"):
            events = list((await handle.fetch_history()).events)
            scheduled = next(
                event
                for event in events
                if event.HasField("activity_task_scheduled_event_attributes")
                and event.activity_task_scheduled_event_attributes.activity_type.name
                == TOOL_ACTIVITY
            )
            completed = next(
                event
                for event in events
                if event.HasField("activity_task_completed_event_attributes")
                and event.activity_task_completed_event_attributes.scheduled_event_id
                == scheduled.event_id
            )
            if mutation in ("missing", "retryable-number"):
                payload = (
                    completed.activity_task_completed_event_attributes.result.payloads[
                        0
                    ]
                )
                value = json.loads(payload.data)
                if mutation == "missing":
                    value["result"] = {}
                else:
                    value["result"]["retryable"] = 0
            else:
                payload = (
                    scheduled.activity_task_scheduled_event_attributes.input.payloads[
                        0 if mutation == "wrong-tool" else 1
                    ]
                )
                value = json.loads(payload.data)
                if mutation == "wrong-tool":
                    value["name"] = "calculate_budget"
                else:
                    value["ownerId"] = str(uuid4())
            payload.data = json.dumps(value).encode()
            with pytest.raises(DomainError, match="TEMPORAL_(TOOL_)?EVIDENCE_INVALID"):
                audit_history(
                    events,
                    evidence,
                    namespace=native.namespace,
                    execution_run_id=native.execution_run_id,
                )
