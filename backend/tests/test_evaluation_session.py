import asyncio
import json
import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from temporalio.testing import WorkflowEnvironment
from test_evaluation_runtime import Generation
from test_quota import policy

from dive_trip.application import agent_runtime
from dive_trip.bootstrap.evaluation_session import EvaluationSession, EvaluationSetup
from dive_trip.modules.usage.provider import GEMINI_MODEL, ProviderBinding
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("invalidate", ["post", "capture"])
async def test_existing_collector_and_replay_contract_through_python_product_routes(
    database, monkeypatch, invalidate
):
    original = agent_runtime.fixture_response

    def scenario(messages, info):
        if any(
            isinstance(part, ToolReturnPart)
            for message in messages
            for part in message.parts
        ):
            return original(messages, info)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "validate_changes",
                    {"changes": [{"kind": "remove", "entryId": "transfer"}]},
                    tool_call_id="collector-validation",
                )
            ]
        )

    monkeypatch.setattr(agent_runtime, "fixture_response", scenario)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    generations = []

    async def load():
        generation = Generation(provider)
        generations.append(generation)
        return generation

    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        session = EvaluationSession(
            database,
            environment.client,
            provider,
            policy(10000000),
            EvaluationLoopbackPeer(b"a" * 32),
            load,
        )
        node = shutil.which("node")
        assert node is not None
        child = await asyncio.create_subprocess_exec(
            node,
            str(ROOT / "backend/tests/evaluation-collector.mjs"),
            cwd=ROOT,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=1048576,
        )
        assert child.stdout is not None and child.stdin is not None
        result = None
        try:
            async with asyncio.timeout(60):
                while line := await child.stdout.readline():
                    command = json.loads(line)
                    operation, input = command["operation"], command["input"]
                    if operation == "result":
                        result = input
                        break
                    assert operation != "error", input
                    if operation == "setup":
                        value = await session.setup(
                            EvaluationSetup.model_validate(input)
                        )
                    elif operation == "request":
                        value = await session.request(input["path"], input["body"])
                    else:
                        assert operation == "audit"
                        value = await session.audit(input["runId"])
                    child.stdin.write((value.model_dump_json() + "\n").encode())
                    await child.stdin.drain()
                child.stdin.close()
                await child.wait()
            assert child.returncode == 0
            assert result is not None
            evidence = result["result"]["evidence"]
            assert not result["result"]["grade"]["safetyFailures"]
            assert evidence["usageComplete"] and evidence["modelCalls"] == 2
            assert evidence["beforeDecisionVersion"] == 1
            assert evidence["afterVersion"] == 2 and evidence["decision"] == "accept"
            assert [row["id"] for row in evidence["after"]["entries"]] == [
                "stay", "tour"
            ]
            assert result["replay"]["schemaVersion"] == 2
            assert result["replay"]["decisionReceipt"]["status"] == "applied"
            assert len(generations) == 1 and generations[0].closed
            with pytest.raises(DomainError, match="EVALUATION_CAPTURE_REQUIRED"):
                await session.setup(
                    EvaluationSetup.model_validate(
                        {
                            "before": result["replay"]["initial"]["trip"]["snapshot"],
                            "catalog": result["replay"]["catalog"],
                        }
                    )
                )
            captured = await session.capture()
            assert captured["privateUsageComplete"] and captured["usageKnown"]
            assert captured["modelCalls"] == 2 and captured["totalTokens"] == 4
            assert captured["record"]["privateUsage"][0]["schemaVersion"] == 3
            assert captured["record"]["nativeHistory"][0]["terminal"] == "completed"
            assert await session.capture() == captured
            for path in (
                "https://example.invalid/",
                "/api/session",
                f"/api/trips/{session.trip.id}/../other/agent",
            ):
                with pytest.raises(DomainError, match="EVALUATION_ROUTE_DISABLED"):
                    await session.request(path, None)
            next_input = EvaluationSetup.model_validate(
                {
                    "before": result["replay"]["initial"]["trip"]["snapshot"],
                    "catalog": result["replay"]["catalog"],
                }
            )
            if invalidate == "post":
                from test_chat_http import start_body

                body = start_body(session.trip.id)
                body["runId"] = str(uuid4())
                body["forwardedProps"]["baseVersion"] = 2
                response = await session.request(
                    f"/api/trips/{session.trip.id}/agent", body
                )
                assert response.status == 200
            else:
                # Extra inventory changes neither model count nor charged cost.
                from dive_trip.application.trips import TripService

                TripService(database).create(
                    session.owner, session.trip.snapshot.model_dump()
                )
                with pytest.raises(DomainError, match="EVALUATION_INVENTORY_CHANGED"):
                    await session.capture()
            with pytest.raises(DomainError, match="EVALUATION_CAPTURE_REQUIRED"):
                await session.setup(next_input)
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()
            await session.close()
