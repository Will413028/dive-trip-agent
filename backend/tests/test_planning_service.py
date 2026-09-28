from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb
from test_budget import snapshot
from test_trip_transactions import owner

from dive_trip.application.planning import PlanningService
from dive_trip.application.trips import TripService
from dive_trip.modules.planning.answer_contract import AnswerPlan
from dive_trip.modules.planning.evidence import Binding
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def setup_run(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [entry.item for entry in trip.snapshot.entries])
    row, _ = service.start(identity, trip.id, "start", "將活動移到第三天", 1)
    binding = Binding(
        ownerId=identity, tripId=trip.id, runId=str(row["id"]), baseVersion=1
    )
    return service, binding


def validate(service, binding):
    service.begin_model(binding, "model-1")
    service.complete_model(
        binding,
        "model-1",
        [
            {
                "id": "validate-1",
                "name": "validate_changes",
                "args": {
                    "changes": [
                        {"kind": "move", "entryId": "tour", "day": 3, "slot": "morning"}
                    ]
                },
            }
        ],
    )
    return service.tool(binding, "validate-1")


def propose(service, binding):
    validation = validate(service, binding)
    service.begin_model(binding, "model-2")
    service.complete_model(
        binding,
        "model-2",
        [
            {
                "id": "proposal-1",
                "name": "propose_changes",
                "args": {"validationId": validation["validationId"]},
            }
        ],
    )
    return service.prepare_proposal(binding, "proposal-1")


@pytest.mark.parametrize("accepted", [True, False])
def test_concurrent_decision_is_atomic_and_never_dispatches_model(database, accepted):
    service, binding = setup_run(database)
    pending = propose(service, binding)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                service.decide,
                binding,
                pending["interruptId"],
                accepted,
                event_request_id=str(uuid4()),
            )
            for _ in range(2)
        ]
        results = [future.result(timeout=15) for future in futures]
    assert results[0] == results[1]
    assert results[0]["receipt"] == {
        "status": "applied" if accepted else "rejected",
        "version": 2 if accepted else 1,
    }
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM planning_model_steps"
            ).fetchone()["n"]
            == 2
        )
        assert connection.execute("SELECT count(*) AS n FROM trip_versions").fetchone()[
            "n"
        ] == (2 if accepted else 1)
        events = [
            row["event"]
            for row in connection.execute(
                "SELECT event FROM agent_run_events ORDER BY sequence"
            )
        ]
        answers = [event["value"] for event in events if event["type"] == "CUSTOM"]
        assert len(answers) == 2
        assert answers[-1] == results[0]["answer"]
    with pytest.raises(DomainError, match="RUN_STATE_CONFLICT"):
        service.decide(
            binding, pending["interruptId"], not accepted, event_request_id=str(uuid4())
        )


def test_saved_validation_mutation_is_rejected_before_proposal(database):
    service, binding = setup_run(database)
    validation = validate(service, binding)
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT result FROM planning_tool_calls WHERE call_id='validate-1'"
        ).fetchone()
        row["result"]["draft"]["next"]["entries"][1]["day"] = 4
        connection.execute(
            "UPDATE planning_tool_calls SET result=%s WHERE call_id='validate-1'",
            (Jsonb(row["result"]),),
        )
    service.begin_model(binding, "model-2")
    service.complete_model(
        binding,
        "model-2",
        [
            {
                "id": "proposal-1",
                "name": "propose_changes",
                "args": {"validationId": validation["validationId"]},
            }
        ],
    )
    with pytest.raises(DomainError, match="AGENT_INVALID_VALIDATION"):
        service.prepare_proposal(binding, "proposal-1")
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM proposals").fetchone()["n"]
            == 0
        )


def test_final_response_closes_model_and_tool_budget(database):
    service, binding = setup_run(database)
    plan = {"version": "1", "answer": {"kind": "clarify", "fields": ["budget"]}}
    service.begin_model(binding, "model-1")
    service.complete_model(
        binding, "model-1", [{"id": "final-1", "name": "final_answer", "args": plan}]
    )
    with pytest.raises(DomainError, match="MODEL_CALL_LIMIT"):
        service.begin_model(binding, "model-2")
    answer = service.finish_answer(binding, AnswerPlan.model_validate(plan))
    assert answer["body"]["kind"] == "clarify"


def test_stale_confirmation_rolls_back_decision_and_receipt(database):
    service, binding = setup_run(database)
    pending = propose(service, binding)
    trips = TripService(database)
    trips.mutate(binding.ownerId, binding.tripId, 1, "manual", "restore", 1)
    with pytest.raises(DomainError, match="STALE_VERSION"):
        service.decide(
            binding, pending["interruptId"], True, event_request_id=str(uuid4())
        )
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT status,decision FROM agent_runs WHERE id=%s", (binding.runId,)
        ).fetchone()
        assert row == {"status": "awaiting_confirmation", "decision": None}
        assert (
            connection.execute(
                "SELECT committed_receipt FROM planning_executions"
            ).fetchone()["committed_receipt"]
            is None
        )


def test_cancel_fences_late_model_result_and_does_not_cancel_saved_proposal(database):
    service, binding = setup_run(database)
    service.begin_model(binding, "model-1")
    assert service.recover(binding, interrupted=True)["status"] == "interrupted"
    with pytest.raises(DomainError, match="RUN_STATE_CONFLICT"):
        service.complete_model(
            binding, "model-1", [{"id": "late", "name": "calculate_budget", "args": {}}]
        )
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM planning_tool_calls"
            ).fetchone()["n"]
            == 0
        )
        assert (
            connection.execute("SELECT completed FROM planning_model_steps").fetchone()[
                "completed"
            ]
            is False
        )
    pending_service, pending_binding = setup_run(database)
    proposal = propose(pending_service, pending_binding)
    assert (
        pending_service.recover(pending_binding, interrupted=True)["status"]
        == "awaiting_confirmation"
    )
    assert (
        pending_service.decide(
            pending_binding,
            proposal["interruptId"],
            False,
            event_request_id=str(uuid4()),
        )["receipt"]["status"]
        == "rejected"
    )


def test_confirmation_commits_without_a_new_executor_lease(database):
    service, binding = setup_run(database)
    pending = propose(service, binding)
    # An isolated DB trigger observes intermediate SQL updates, so the test also
    # rejects an unobservable awaiting -> running -> succeeded detour.
    with database.transaction() as connection:
        connection.execute("""CREATE FUNCTION forbid_confirmation_executor()
        RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.status='awaiting_confirmation' AND
             (NEW.status='running' OR NEW.lease_expires_at IS NOT NULL) THEN
            RAISE EXCEPTION 'confirmation must not create an executor lease';
          END IF;
          RETURN NEW;
        END $$""")
        connection.execute("""CREATE TRIGGER confirmation_without_executor
        BEFORE UPDATE ON agent_runs FOR EACH ROW
        EXECUTE FUNCTION forbid_confirmation_executor()""")
    assert (
        service.decide(
            binding, pending["interruptId"], True, event_request_id=str(uuid4())
        )["receipt"]["version"]
        == 2
    )


def test_model_turns_share_the_original_invocation_deadline(database):
    service, binding = setup_run(database)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE agent_runs SET created_at=clock_timestamp()-interval '56 seconds'"
        )
    with pytest.raises(DomainError, match="AGENT_DEADLINE"):
        service.begin_model(binding, "too-late")
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM planning_model_steps"
            ).fetchone()["n"]
            == 0
        )
