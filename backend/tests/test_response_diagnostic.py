import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import (
    CompactionPart,
    ModelResponse,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
)
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
        ("text", "AGENT_MODEL_RESPONSE_NON_TOOL_TEXT", 1),
        ("non-tool-thinking", "AGENT_MODEL_RESPONSE_NON_TOOL_THINKING", 1),
        ("non-tool-both", "AGENT_MODEL_RESPONSE_NON_TOOL_TEXT_THINKING", 1),
        ("non-tool-other", "AGENT_MODEL_RESPONSE_NON_TOOL_OTHER", 1),
        ("mixed-invalid", "AGENT_TOOL_ARGUMENTS_REJECTED", 1),
        ("thinking", "AGENT_MODEL_RESPONSE_MIXED_THINKING", 1),
        ("both", "AGENT_MODEL_RESPONSE_MIXED_TEXT_THINKING", 1),
        ("other", "AGENT_MODEL_RESPONSE_MIXED_OTHER", 1),
        ("duplicate", "AGENT_MODEL_RESPONSE_DUPLICATE_CALL_ID", 1),
        ("reused", "AGENT_MODEL_RESPONSE_REUSED_CALL_ID", 2),
        ("limit-final", "AGENT_TOOL_LIMIT_FINAL_ONLY", 7),
        ("limit-budget", "AGENT_TOOL_LIMIT_BUDGET_ONLY", 7),
        ("limit-mixed", "AGENT_TOOL_LIMIT_MIXED_NAMES", 7),
        ("limit-undeclared", "AGENT_TOOL_LIMIT_UNDECLARED_NAME", 7),
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
        if mode.startswith("limit-"):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            if len(returns) < 6:
                return ModelResponse(
                    parts=[
                        ToolCallPart(
                            "calculate_budget",
                            {},
                            tool_call_id=f"budget-{len(returns)}",
                        )
                    ]
                )
            name = {
                "limit-final": "final_answer",
                "limit-budget": "calculate_budget",
                "limit-mixed": "final_answer",
                "limit-undeclared": "SECRET_RESPONSE_VALUE",
            }[mode]
            parts = [
                ToolCallPart(
                    name,
                    {"private": "SECRET_RESPONSE_VALUE"},
                    tool_call_id="SECRET_RESPONSE_VALUE",
                )
            ]
            if mode == "limit-mixed":
                parts.append(ToolCallPart("calculate_budget", {}, tool_call_id="extra"))
            return ModelResponse(parts=parts)
        call = ToolCallPart("calculate_budget", {}, tool_call_id="synthetic-call")
        if mode == "empty":
            return ModelResponse(parts=[])
        if mode == "text":
            return ModelResponse(parts=[TextPart("SECRET_RESPONSE_VALUE")])
        if mode.startswith("non-tool-"):
            parts = {
                "non-tool-thinking": [ThinkingPart("SECRET_RESPONSE_VALUE")],
                "non-tool-both": [
                    TextPart("SECRET_RESPONSE_VALUE"),
                    ThinkingPart("SECRET_RESPONSE_VALUE"),
                ],
                "non-tool-other": [
                    TextPart("SECRET_RESPONSE_VALUE"),
                    CompactionPart("SECRET_RESPONSE_VALUE"),
                ],
            }[mode]
            return ModelResponse(parts=parts)
        if mode == "mixed-invalid":
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "calculate_budget",
                        {"extra": True},
                        tool_call_id="synthetic-call",
                    ),
                    TextPart("SECRET_RESPONSE_VALUE"),
                ]
            )
        if mode == "thinking":
            return ModelResponse(parts=[call, ThinkingPart("SECRET_RESPONSE_VALUE")])
        if mode == "both":
            return ModelResponse(
                parts=[
                    call,
                    TextPart("SECRET_RESPONSE_VALUE"),
                    ThinkingPart("SECRET_RESPONSE_VALUE"),
                ]
            )
        if mode == "other":
            return ModelResponse(parts=[call, CompactionPart("SECRET_RESPONSE_VALUE")])
        if mode == "duplicate":
            return ModelResponse(parts=[call, TextPart("SECRET_RESPONSE_VALUE"), call])
        assert mode == "reused"
        assert not any(
            isinstance(part, ToolReturnPart) and part.tool_name != "calculate_budget"
            for message in messages
            for part in message.parts
        )
        return ModelResponse(parts=[call, TextPart("SECRET_RESPONSE_VALUE")])

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
        assert all(
            b"SECRET_RESPONSE_VALUE" not in event.SerializeToString()
            for event in history.events
        )
        evidence = read_usage_evidence(database, binding, provider)
        assert evidence.status == "failed"
        assert len(evidence.calls) == calls
        assert all(call.event.usage is not None for call in evidence.calls)
        assert (
            (evidence.invocations[0].actual_cost_micros is not None)
            if mode == "mixed-invalid"
            else (evidence.invocations[0].actual_cost_micros is None)
        )
        assert len(evidence.tools) == (
            6 if mode.startswith("limit-") else (1 if mode == "reused" else 0)
        )
        with database.transaction() as connection:
            events = connection.execute(
                "SELECT event FROM agent_run_events "
                "WHERE run_id = %s ORDER BY sequence",
                (binding.runId,),
            ).fetchall()
            public = json.dumps(events)
            assert "SECRET_RESPONSE_VALUE" not in public
            assert "AGENT_MODEL_RESPONSE" not in public
            assert "AGENT_TOOL_LIMIT" not in public
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


@pytest.mark.parametrize(
    ("parts", "code"),
    [
        ([TextPart("a")], "AGENT_MODEL_RESPONSE_MIXED_TEXT"),
        ([ThinkingPart("a")], "AGENT_MODEL_RESPONSE_MIXED_THINKING"),
        ([TextPart(""), ThinkingPart("")], "AGENT_MODEL_RESPONSE_MIXED_TEXT_THINKING"),
        ([CompactionPart("a")], "AGENT_MODEL_RESPONSE_MIXED_OTHER"),
        ([TextPart("a"), CompactionPart("a")], "AGENT_MODEL_RESPONSE_MIXED_OTHER"),
        ([], "AGENT_MODEL_RESPONSE_DIAGNOSTIC_INVALID"),
    ],
)
def test_mixed_classification_uses_only_known_types(parts, code):
    call = ToolCallPart("calculate_budget", {}, tool_call_id="synthetic-call")
    response = ModelResponse(parts=[call, *parts])
    assert agent_runtime.mixed_response_code(response) == code
    response.parts.reverse()
    assert agent_runtime.mixed_response_code(response) == code


async def test_mixed_text_runs_validated_tools_without_persisting_or_reusing_prose(
    database, monkeypatch
):
    identity, trip, _, catalog = setup(database)
    binding, _, _ = start(AdmissionService(database, catalog), identity, trip)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(database, [], accounting=RuntimeAccounting(provider))
    original = agent_runtime.fixture_response
    requests = []

    def scenario(messages, info):
        serialized = agent_runtime.ModelMessagesTypeAdapter.dump_json(messages)
        assert b"SECRET_RESPONSE_VALUE" not in serialized
        requests.append(serialized)
        response = (
            original(messages, info)
            if any(
                isinstance(part, ToolReturnPart)
                for message in messages
                for part in message.parts
            )
            else ModelResponse(
                parts=[
                    ToolCallPart("calculate_budget", {}, tool_call_id="fixture-read")
                ]
            )
        )
        response.metadata = {"raw": "SECRET_RESPONSE_VALUE"}
        response.provider_details = {"raw": "SECRET_RESPONSE_VALUE"}
        response.parts = [
            TextPart(
                "SECRET_RESPONSE_VALUE",
                provider_details={"raw": "SECRET_RESPONSE_VALUE"},
            ),
            *response.parts,
        ]
        return response

    monkeypatch.setattr(agent_runtime, "fixture_response", scenario)
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"mixed-text-{uuid4().hex}"
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
                    result = await handle.result()
        history = await handle.fetch_history()
        assert all(
            b"SECRET_RESPONSE_VALUE" not in event.SerializeToString()
            for event in history.events
        )
        evidence = read_usage_evidence(database, binding, provider)
        assert evidence.status == "succeeded"
        assert len(requests) == len(evidence.calls) == 2
        assert len(evidence.tools) == 1
        assert evidence.invocations[0].actual_cost_micros is not None
        with database.transaction() as connection:
            events = connection.execute(
                "SELECT event FROM agent_run_events "
                "WHERE run_id = %s ORDER BY sequence",
                (binding.runId,),
            ).fetchall()
            public = json.dumps(events)
            assert "SECRET_RESPONSE_VALUE" not in public
            assert "dive_trip.answer.v1" in public
            assert (
                connection.execute("SELECT count(*) AS n FROM proposals").fetchone()[
                    "n"
                ]
                == 0
            )
            assert (
                connection.execute(
                    "SELECT current_version FROM trips WHERE id = %s", (trip.id,)
                ).fetchone()["current_version"]
                == trip.version
            )
        assert result is not None


@pytest.mark.parametrize(
    ("parts", "code"),
    [
        ([TextPart("SECRET_RESPONSE_VALUE")], "AGENT_MODEL_RESPONSE_NON_TOOL_TEXT"),
        ([TextPart("")], "AGENT_MODEL_RESPONSE_NON_TOOL_TEXT"),
        (
            [ThinkingPart("SECRET_RESPONSE_VALUE")],
            "AGENT_MODEL_RESPONSE_NON_TOOL_THINKING",
        ),
        (
            [TextPart(""), ThinkingPart("")],
            "AGENT_MODEL_RESPONSE_NON_TOOL_TEXT_THINKING",
        ),
        (
            [CompactionPart("SECRET_RESPONSE_VALUE")],
            "AGENT_MODEL_RESPONSE_NON_TOOL_OTHER",
        ),
        (
            [ThinkingPart(""), TextPart(""), CompactionPart("")],
            "AGENT_MODEL_RESPONSE_NON_TOOL_OTHER",
        ),
        ([], "AGENT_MODEL_RESPONSE_DIAGNOSTIC_INVALID"),
    ],
)
def test_non_tool_classification_uses_only_known_types(parts, code):
    response = ModelResponse(parts=parts)
    assert agent_runtime.non_tool_response_code(response) == code
    response.parts.reverse()
    assert agent_runtime.non_tool_response_code(response) == code
