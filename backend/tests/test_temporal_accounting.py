import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_budget import snapshot
from test_quota import policy
from test_trip_transactions import owner

from dive_trip.application.admission import AdmissionService
from dive_trip.application.agent_runtime import (
    SyntheticGeneration,
    bind_receipt_worker_service,
    bind_worker_service,
)
from dive_trip.application.planning import PlanningService
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.temporal_evidence import (
    audit_history,
    read_temporal_evidence,
)
from dive_trip.application.trips import TripService
from dive_trip.application.usage_audit import reconcile_usage
from dive_trip.application.usage_evidence import read_usage_evidence
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow, prepare_proposal
from dive_trip.modules.usage.provider import CLOUDFLARE_MODEL, GEMINI_MODEL
from dive_trip.modules.usage.public import ModelUsageEvent, ProviderBinding
from dive_trip.platform.errors import DomainError, ToolArgumentsRejected

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "provider,model,expected_cost,lost_proposal_ack",
    [
        ("gemini", GEMINI_MODEL, 4, False),
        ("openrouter", "vendor/model:free", 0, False),
        ("cloudflare", CLOUDFLARE_MODEL, 2, False),
        pytest.param("gemini", GEMINI_MODEL, 4, True, id="lost-proposal-ack"),
    ],
)
@pytest.mark.parametrize("accepted", [True, False])
async def test_synthetic_provider_usage_precedes_result_and_receipt_is_model_free(
    database, provider, model, expected_cost, lost_proposal_ack, accepted
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    expected = ProviderBinding(
        provider=provider,
        model=model,
        accountId="a" * 32 if provider == "cloudflare" else None,
    )
    admission = AdmissionService(database, catalog)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(expected))
    generation = SyntheticGeneration(expected, "synthetic-not-a-real-key")

    @activity.defn(name="prepare_proposal")
    async def lose_completion(call_id):
        await prepare_proposal(call_id)
        raise ApplicationError("SYNTHETIC_COMPLETION_LOST", non_retryable=True)

    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        binding, _, _ = admission.start(
            identity,
            trip.id,
            "start",
            "fixture:move-tour",
            1,
            expected,
            "a" * 64,
            50,
            datetime.now(UTC),
            policy(),
        )
        queue = f"dive-accounting-{uuid4().hex}"
        with bind_worker_service(service, generation):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=[
                    lose_completion
                    if lost_proposal_ack and item is prepare_proposal
                    else item
                    for item in ACTIVITIES
                ],
            ):
                handle = await environment.client.start_workflow(
                    TripWorkflow.run,
                    id=f"dive-trip-v1:{binding.runId}",
                    task_queue=queue,
                    execution_timeout=timedelta(seconds=45),
                )
                async with asyncio.timeout(20):
                    while not await handle.query(TripWorkflow.awaiting_confirmation):
                        await asyncio.sleep(0.05)
                with database.transaction() as connection:
                    calls = connection.execute(
                        "SELECT status,usage FROM model_calls ORDER BY started_at"
                    ).fetchall()
                    assert len(calls) == 2
                    assert all(
                        call["status"] == "completed"
                        and call["usage"]["totalTokens"] == 2
                        for call in calls
                    )
                    reservation = connection.execute(
                        "SELECT actual_cost_micros,charged_cost_micros,status "
                        "FROM quota_reservations"
                    ).fetchone()
                    assert reservation == {
                        "actual_cost_micros": expected_cost,
                        "charged_cost_micros": expected_cost,
                        "status": "settled",
                    }
                    interrupt = connection.execute(
                        "SELECT interrupt_id FROM agent_runs"
                    ).fetchone()["interrupt_id"]
                    public = connection.execute(
                        "SELECT event FROM agent_run_events"
                    ).fetchall()
                    assert "promptTokens" not in str(public)
                    assert "providerEvidence" not in str(public)
        # The start worker is fully stopped before admission of the receipt.
        # This worker has provider identity, no generation object or credential.
        before = read_usage_evidence(database, binding, expected)
        with database.transaction() as connection:
            first_tool = connection.execute(
                "SELECT call_id,result FROM planning_tool_calls "
                "WHERE name='propose_changes'"
            ).fetchone()
            connection.execute(
                "UPDATE planning_tool_calls SET completed=false,result=NULL "
                "WHERE call_id=%s",
                (first_tool["call_id"],),
            )
        try:
            with pytest.raises(DomainError):
                read_usage_evidence(database, binding, expected)
        finally:
            with database.transaction() as connection:
                connection.execute(
                    "UPDATE planning_tool_calls SET completed=true,result=%s "
                    "WHERE call_id=%s",
                    (Jsonb(first_tool["result"]), first_tool["call_id"]),
                )
        checkpoint = await read_temporal_evidence(environment.client, before)
        assert checkpoint.terminal == "awaiting_confirmation"
        assert len(checkpoint.models) == 2
        history = await handle.fetch_history()
        for altered in (
            before.model_copy(update={"tools": []}),
            before.model_copy(
                update={
                    "steps": [
                        before.steps[0].model_copy(update={"completed": False}),
                        *before.steps[1:],
                    ]
                }
            ),
            before.model_copy(update={"status": "running"}),
        ):
            with pytest.raises(DomainError):
                audit_history(
                    list(history.events),
                    altered,
                    namespace=checkpoint.namespace,
                    execution_run_id=checkpoint.execution_run_id,
                )
        with bind_receipt_worker_service(service):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                committed = await asyncio.to_thread(
                    admission.resume,
                    binding,
                    interrupt,
                    accepted,
                    expected,
                    "a" * 64,
                    datetime.now(UTC),
                    policy(),
                    event_request_id=str(uuid4()),
                )
                await handle.signal(TripWorkflow.decision_committed)
                async with asyncio.timeout(10):
                    assert await handle.result() == committed
        after = read_usage_evidence(database, binding, expected)
        completed = await read_temporal_evidence(environment.client, after)
        assert completed.terminal == "completed"
        assert completed.models == checkpoint.models
        assert after.calls == before.calls
        audit = reconcile_usage(after, completed, previous=(before, checkpoint))
        assert audit.complete and audit.modelCalls == 2
        assert audit.model_dump(mode="json")["faultObserved"] is None
        assert audit.decisionReceipt.status == ("applied" if accepted else "rejected")
        assert audit.decisionReceipt.version == (2 if accepted else 1)
        with pytest.raises(DomainError, match="START_CHECKPOINT_REQUIRED"):
            reconcile_usage(after, completed)
        with pytest.raises(DomainError, match="RESUME_GENERATION"):
            reconcile_usage(
                after,
                completed.model_copy(update={"models": []}),
                previous=(before, checkpoint),
            )
        for mutation in ("empty", "boolean-schema", "boolean-version"):
            terminal_history = list((await handle.fetch_history()).events)
            result = after.decision.model_dump(mode="json")
            if mutation == "empty":
                result = {}
            elif mutation == "boolean-schema":
                result["answer"]["schemaVersion"] = True
            else:
                result["receipt"]["version"] = True
                result["answer"]["body"]["version"] = True
            payload = terminal_history[
                -1
            ].workflow_execution_completed_event_attributes.result.payloads[0]
            payload.data = json.dumps(result).encode()
            with pytest.raises(DomainError, match="TEMPORAL_DECISION_INVALID"):
                audit_history(
                    terminal_history,
                    after,
                    namespace=completed.namespace,
                    execution_run_id=completed.execution_run_id,
                )
        assert [item.kind for item in after.invocations] == ["start", "resume"]
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()[
                    "n"
                ]
                == 2
            )
            assert connection.execute(
                "SELECT max_cost_micros,status FROM agent_invocations "
                "WHERE kind='resume'"
            ).fetchone() == {"max_cost_micros": 0, "status": "settled"}


def test_provider_identity_alone_does_not_enable_generation(database):
    binding = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(database, [], accounting=RuntimeAccounting(binding))
    with pytest.raises(DomainError, match="MODEL_GENERATION_DISABLED"):
        with bind_worker_service(service):
            pytest.fail("must reject before creating a worker")
    with pytest.raises(DomainError, match="SYNTHETIC_CREDENTIAL_REQUIRED"):
        SyntheticGeneration(binding, "not-authorized")


async def test_receipt_worker_rejects_accidental_agent_execution_before_call_start(
    database,
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(provider))
    binding, _, _ = AdmissionService(database, catalog).start(
        identity,
        trip.id,
        "accidental-start",
        "fixture:budget",
        1,
        provider,
        "a" * 64,
        50,
        datetime.now(UTC),
        policy(),
    )
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        with bind_receipt_worker_service(service):
            async with Worker(
                environment.client,
                task_queue=f"receipt-{uuid4().hex}",
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ) as worker:
                handle = await environment.client.start_workflow(
                    TripWorkflow.run,
                    id=f"dive-trip-v1:{binding.runId}",
                    task_queue=worker.task_queue,
                    execution_timeout=timedelta(seconds=30),
                )
                async with asyncio.timeout(15):
                    with pytest.raises(WorkflowFailureError):
                        await handle.result()
    with database.transaction() as connection:
        assert connection.execute("SELECT * FROM model_calls").fetchall() == []
        assert connection.execute("SELECT * FROM planning_model_steps").fetchall() == []
        assert connection.execute(
            "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
        ).fetchone() == {"actual_cost_micros": None, "charged_cost_micros": 50}


async def test_usage_persistence_failure_withholds_result_and_retains_unknown_cost(
    database,
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    expected = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    admission = AdmissionService(database, catalog)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(expected))
    with database.transaction() as connection:
        connection.execute("""CREATE FUNCTION refuse_private_usage() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'synthetic usage write failure';
        END $$""")
        connection.execute("""CREATE TRIGGER usage_write_failure
        BEFORE UPDATE ON model_calls
        FOR EACH ROW EXECUTE FUNCTION refuse_private_usage()""")
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        binding, _, _ = admission.start(
            identity,
            trip.id,
            "start",
            "fixture:budget",
            1,
            expected,
            "a" * 64,
            50,
            datetime.now(UTC),
            policy(),
        )
        queue = f"dive-usage-failure-{uuid4().hex}"
        with bind_worker_service(
            service, SyntheticGeneration(expected, "synthetic-not-a-real-key")
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
                    execution_timeout=timedelta(seconds=30),
                )
                with pytest.raises(WorkflowFailureError):
                    async with asyncio.timeout(20):
                        await handle.result()
        with database.transaction() as connection:
            calls = connection.execute(
                "SELECT status,usage FROM model_calls"
            ).fetchall()
            assert calls == [{"status": "started", "usage": None}]
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_tool_calls"
                ).fetchone()["n"]
                == 0
            )
            assert (
                connection.execute("SELECT status FROM agent_runs").fetchone()["status"]
                == "failed"
            )
            assert connection.execute(
                "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
            ).fetchone() == {"actual_cost_micros": None, "charged_cost_micros": 50}
            answers = connection.execute(
                "SELECT event->'value' AS answer FROM agent_run_events "
                "WHERE event->>'type'='CUSTOM'"
            ).fetchall()
            assert len(answers) == 1
            assert answers[0]["answer"]["body"] == {
                "kind": "failure",
                "reason": "invalid-answer",
                "committed": None,
            }


async def test_drained_tool_argument_rejection_settles_known_cost_without_retry(
    database,
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    expected = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    admission = AdmissionService(database, catalog)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(expected))
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        binding, _, _ = admission.start(
            identity,
            trip.id,
            "start",
            "fixture:invalid-tool-arguments",
            1,
            expected,
            "a" * 64,
            50,
            datetime.now(UTC),
            policy(),
        )
        queue = f"dive-argument-failure-{uuid4().hex}"
        with bind_worker_service(
            service, SyntheticGeneration(expected, "synthetic-not-a-real-key")
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
                    execution_timeout=timedelta(seconds=30),
                )
                with pytest.raises(WorkflowFailureError):
                    async with asyncio.timeout(20):
                        await handle.result()
                history = await handle.fetch_history()
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT status FROM agent_runs").fetchone()["status"]
                == "failed"
            )
            assert connection.execute(
                "SELECT completed,arguments_rejected FROM planning_model_steps"
            ).fetchall() == [{"completed": True, "arguments_rejected": True}]
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_tool_calls"
                ).fetchone()["n"]
                == 0
            )
            assert connection.execute(
                "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
            ).fetchone() == {"actual_cost_micros": 2, "charged_cost_micros": 2}
        models = [
            event.activity_task_scheduled_event_attributes
            for event in history.events
            if event.HasField("activity_task_scheduled_event_attributes")
            and "model"
            in event.activity_task_scheduled_event_attributes.activity_type.name
        ]
        assert len(models) == 1 and models[0].retry_policy.maximum_attempts == 1


@pytest.mark.parametrize(
    "reason", ["missing-activity-completion", "cancelled", "expired"]
)
def test_rejection_journal_alone_cannot_release_unknown_reservation(database, reason):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    admission = AdmissionService(database, catalog)
    binding, _, _ = admission.start(
        identity,
        trip.id,
        "start",
        "synthetic",
        1,
        provider,
        "a" * 64,
        50,
        datetime.now(UTC),
        policy(),
    )
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(provider))
    service.begin_model(binding, "model-1")
    service.account_usage(
        binding,
        ModelUsageEvent.model_validate(
            {
                "kind": "model-call-usage",
                "callId": "model-1",
                "usage": {"promptTokens": 1, "outputTokens": 1, "totalTokens": 2},
            }
        ),
    )
    with pytest.raises(ToolArgumentsRejected):
        service.complete_model(
            binding,
            "model-1",
            [
                {
                    "id": "invalid",
                    "name": "calculate_budget",
                    "args": {"private_field": "SECRET_VALUE"},
                }
            ],
        )
    with database.transaction() as connection:
        step = connection.execute(
            "SELECT completed,arguments_rejected,argument_diagnostic "
            "FROM planning_model_steps WHERE run_id=%s AND activity_id='model-1'",
            (binding.runId,),
        ).fetchone()
    assert step == {
        "completed": True,
        "arguments_rejected": True,
        "argument_diagnostic": {
            "tool": "calculate_budget",
            "candidate_ordinal": 1,
            "issues": [{"code": "extra_forbidden", "path": ["?"]}],
        },
    }
    with pytest.raises(DomainError, match="MODEL_GENERATION_DISABLED"):
        service.begin_model(binding, "must-not-retry")
    if reason == "expired":
        with database.transaction() as connection:
            connection.execute(
                "UPDATE agent_runs SET "
                "lease_expires_at=clock_timestamp()-interval '1 second'"
            )
    service.recover(
        binding,
        interrupted=reason == "cancelled",
        rejected_activity=None
        if reason == "missing-activity-completion"
        else "model-1",
    )
    evidence = read_usage_evidence(database, binding, provider)
    assert evidence.steps[0].argument_diagnostic is not None
    assert evidence.steps[0].argument_diagnostic.model_dump(mode="json") == step[
        "argument_diagnostic"
    ]
    assert "private_field" not in evidence.model_dump_json()
    assert "SECRET_VALUE" not in evidence.model_dump_json()
    with database.transaction() as connection:
        events = connection.execute(
            "SELECT event FROM agent_run_events WHERE run_id=%s", (binding.runId,)
        ).fetchall()
        assert "private_field" not in json.dumps(events)
        assert "SECRET_VALUE" not in json.dumps(events)
        assert (
            connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()["n"]
            == 1
        )
        assert connection.execute(
            "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
        ).fetchone() == {"actual_cost_micros": None, "charged_cost_micros": 50}
