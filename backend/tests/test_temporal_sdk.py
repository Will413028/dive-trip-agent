import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx2 as httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_budget import snapshot
from test_provider_sdk import binding, reply
from test_quota import policy
from test_trip_transactions import owner

from dive_trip.application.admission import AdmissionService
from dive_trip.application.agent_runtime import bind_worker_service
from dive_trip.application.planning import PlanningService
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.temporal_evidence import (
    audit_history,
    read_temporal_evidence,
)
from dive_trip.application.trips import TripService
from dive_trip.application.usage_evidence import read_usage_evidence
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.platform.errors import DomainError
from dive_trip.platform.provider_sdk import OfflineSdkGeneration

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
@pytest.mark.parametrize("failure", [None, "ambiguous", "preflight"])
async def test_native_sdk_temporal_persists_before_dispatch_and_never_retries_unknown(
    database, provider, failure
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    expected = binding(provider)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(expected))
    run, _, _ = AdmissionService(database, catalog).start(
        identity,
        trip.id,
        "sdk-start",
        "synthetic request",
        1,
        expected,
        "a" * 64,
        50,
        datetime.now(UTC),
        policy(),
    )
    if failure == "preflight":
        with database.transaction() as connection:
            connection.execute(
                "UPDATE agent_runs SET "
                "created_at=clock_timestamp()-interval '56 seconds' "
                "WHERE id=%s",
                (run.runId,),
            )
    dispatches = []

    def transport(request):
        with database.transaction() as connection:
            calls = connection.execute("SELECT status FROM model_calls").fetchall()
            assert calls == [{"status": "started"}]
        dispatches.append(request)
        if failure == "ambiguous":
            # Request was accepted by the remote transport, then the connection
            # vanished. Retrying would be a second potentially billed dispatch.
            raise httpx.ReadError("PRIVATE_REMOTE_FAILURE", request=request)
        raw = reply(provider)
        args = {"version": "1", "answer": {"kind": "clarify", "fields": ["people"]}}
        if provider == "gemini":
            call = raw["candidates"][0]["content"]["parts"][0]["functionCall"]
            call["name"], call["args"] = "final_answer", args
        else:
            body = raw
            call = body["choices"][0]["message"]["tool_calls"][0]["function"]
            call["name"], call["arguments"] = "final_answer", json.dumps(args)
        return httpx.Response(200, json=raw)

    generation = OfflineSdkGeneration(
        expected, "synthetic-not-a-real-key", httpx.MockTransport(transport)
    )
    try:
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()]
        ) as environment:
            queue = f"sdk-{uuid4().hex}"
            with bind_worker_service(service, generation):
                async with Worker(
                    environment.client,
                    task_queue=queue,
                    workflows=[TripWorkflow],
                    activities=ACTIVITIES,
                ):
                    handle = await environment.client.start_workflow(
                        TripWorkflow.run,
                        id=f"dive-trip-v1:{run.runId}",
                        task_queue=queue,
                        execution_timeout=timedelta(seconds=45),
                    )
                    async with asyncio.timeout(20):
                        if failure:
                            with pytest.raises(WorkflowFailureError):
                                await handle.result()
                        else:
                            assert (await handle.result())["body"]["kind"] == "clarify"
                    history = await handle.fetch_history()
                    serialized = b"".join(
                        event.SerializeToString() for event in history.events
                    )
                    assert b"PRIVATE_REMOTE_FAILURE" not in serialized
                    assert b"synthetic-not-a-real-key" not in serialized
                    scheduled = [
                        event.activity_task_scheduled_event_attributes
                        for event in history.events
                        if event.HasField("activity_task_scheduled_event_attributes")
                    ]
                    scheduled = [
                        item for item in scheduled if "model" in item.activity_type.name
                    ]
                    assert len(scheduled) == 1
                    assert scheduled[0].retry_policy.maximum_attempts == 1
                    try:
                        evidence = read_usage_evidence(database, run, expected)
                    except DomainError as error:
                        if isinstance(error.__context__, ValidationError):
                            pytest.fail(
                                str(
                                    error.__context__.errors(
                                        include_input=False,
                                        include_context=False,
                                        include_url=False,
                                    )
                                )
                            )
                        raise
                    native = await read_temporal_evidence(environment.client, evidence)
                    assert evidence.execution_run_id == handle.first_execution_run_id
                    with pytest.raises(
                        DomainError, match="TEMPORAL_EXECUTION_CONFLICT"
                    ):
                        service.worker_execution(handle.id, str(uuid4()))
                    assert len(native.models) == 1
                    if failure == "preflight":
                        assert evidence.calls == evidence.steps == []
                        assert native.models[0].pre_dispatch_rejected
                    else:
                        assert (
                            native.models[0].activity_id
                            == evidence.calls[0].event.callId
                        )
                        assert not native.models[0].pre_dispatch_rejected
                    assert native.models[0].terminal == (
                        "failed" if failure else "completed"
                    )
                    for tamper in (
                        "retry",
                        "identity",
                        "missing-call",
                        "sequence",
                        "unclosed",
                    ):
                        changed = type(history.events[0])()
                        changed.CopyFrom(history.events[0])
                        events = [changed, *history.events[1:]]
                        altered = evidence
                        if tamper == "identity":
                            start = changed.workflow_execution_started_event_attributes
                            start.original_execution_run_id = str(uuid4())
                        elif tamper == "sequence":
                            changed.event_id = 2
                        elif tamper == "unclosed":
                            events.pop()
                        elif tamper == "missing-call":
                            if failure == "preflight":
                                continue
                            altered = evidence.model_copy(
                                update={"calls": [], "steps": []}
                            )
                        else:
                            for index, event in enumerate(events):
                                scheduled = (
                                    event.activity_task_scheduled_event_attributes
                                )
                                if (
                                    event.HasField(
                                        "activity_task_scheduled_event_attributes"
                                    )
                                    and scheduled.activity_type.name
                                    == "agent__dive_trip_fixture_v1__model_request"
                                ):
                                    replacement = type(event)()
                                    replacement.CopyFrom(event)
                                    attributes = getattr(
                                        replacement,
                                        "activity_task_scheduled_event_attributes",
                                    )
                                    attributes.retry_policy.maximum_attempts = 2
                                    events[index] = replacement
                        with pytest.raises(DomainError):
                            audit_history(
                                events,
                                altered,
                                namespace=native.namespace,
                                execution_run_id=native.execution_run_id,
                            )
    finally:
        await generation.aclose()
    assert len(dispatches) == (0 if failure == "preflight" else 1)
    with database.transaction() as connection:
        state = connection.execute("SELECT status FROM agent_runs").fetchone()
        cost = connection.execute(
            "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
        ).fetchone()
        row = connection.execute("SELECT usage FROM model_calls").fetchone()
        usage = row["usage"] if row is not None else None
        if failure:
            assert state["status"] == "failed"
            assert usage is None
            assert cost == {"actual_cost_micros": None, "charged_cost_micros": 50}
        else:
            assert state["status"] == "succeeded"
            assert usage["totalTokens"] == 5
            assert (
                cost["actual_cost_micros"]
                == {"gemini": 4, "openrouter": 0, "cloudflare": 1}[provider]
            )
