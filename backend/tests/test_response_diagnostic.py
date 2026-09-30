import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_admission import setup, start

from dive_trip.application import agent_runtime
from dive_trip.application.admission import AdmissionService
from dive_trip.application.agent_runtime import SyntheticGeneration, bind_worker_service
from dive_trip.application.planning import PlanningService
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.usage_evidence import read_usage_evidence
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.usage.provider import GEMINI_MODEL, ProviderBinding


@pytest.mark.parametrize(
    ("mode", "code", "calls"),
    [
        ("empty", "AGENT_MODEL_RESPONSE_EMPTY_PARTS", 1),
        ("text", "AGENT_MODEL_RESPONSE_NON_TOOL_PARTS", 1),
        ("mixed", "AGENT_MODEL_RESPONSE_MIXED_PARTS", 1),
        ("duplicate", "AGENT_MODEL_RESPONSE_DUPLICATE_CALL_ID", 1),
        ("reused", "AGENT_MODEL_RESPONSE_REUSED_CALL_ID", 2),
    ],
)
async def test_private_response_codes_do_not_escape_or_authorize_settlement(
    database, monkeypatch, mode, code, calls
):
    identity, trip, _, catalog = setup(database)
    binding, _, _ = start(AdmissionService(database, catalog), identity, trip)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(database, [], accounting=RuntimeAccounting(provider))

    def scenario(messages, _info):
        call = ToolCallPart("calculate_budget", {}, tool_call_id="synthetic-call")
        if mode == "empty":
            return ModelResponse(parts=[])
        if mode == "text":
            return ModelResponse(parts=[TextPart("SECRET_RESPONSE_VALUE")])
        if mode == "mixed":
            return ModelResponse(parts=[call, TextPart("SECRET_RESPONSE_VALUE")])
        if mode == "duplicate":
            return ModelResponse(parts=[call, call])
        assert mode == "reused"
        assert not any(
            isinstance(part, ToolReturnPart) and part.tool_name != "calculate_budget"
            for message in messages
            for part in message.parts
        )
        return ModelResponse(parts=[call])

    monkeypatch.setattr(agent_runtime, "fixture_response", scenario)
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"response-diagnostic-{uuid4().hex}"
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
                    with pytest.raises(WorkflowFailureError):
                        await handle.result()
        history = await handle.fetch_history()
        failures = [
            event.activity_task_failed_event_attributes.failure
            for event in history.events
            if event.HasField("activity_task_failed_event_attributes")
        ]
        assert any(failure.message == code for failure in failures)
        assert all("SECRET_RESPONSE_VALUE" not in str(failure) for failure in failures)
        evidence = read_usage_evidence(database, binding, provider)
        assert evidence.status == "failed"
        assert len(evidence.calls) == calls
        assert all(call.event.usage is not None for call in evidence.calls)
        assert evidence.invocations[0].actual_cost_micros is None
        assert len(evidence.tools) == (1 if mode == "reused" else 0)
        with database.transaction() as connection:
            events = connection.execute(
                "SELECT event FROM agent_run_events "
                "WHERE run_id = %s ORDER BY sequence",
                (binding.runId,),
            ).fetchall()
            public = json.dumps(events)
            assert "SECRET_RESPONSE_VALUE" not in public
            assert "AGENT_MODEL_RESPONSE" not in public
            assert "AGENT_FAILED" in public
            assert (
                connection.execute("SELECT count(*) AS n FROM proposals").fetchone()[
                    "n"
                ]
                == 0
            )
            current = connection.execute(
                "SELECT current_version FROM trips WHERE id = %s", (trip.id,)
            ).fetchone()
            assert current["current_version"] == trip.version
