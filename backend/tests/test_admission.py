from datetime import UTC, datetime
from uuid import uuid4

import pytest
from test_budget import snapshot
from test_quota import policy
from test_trip_transactions import owner

from dive_trip.application.admission import AdmissionService
from dive_trip.application.planning import PlanningService
from dive_trip.application.trips import TripService
from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.compiler import compile_answer
from dive_trip.modules.planning.evidence import Compilation, Evidence
from dive_trip.modules.trips import transactions as trips
from dive_trip.modules.usage.provider import GEMINI_MODEL
from dive_trip.modules.usage.public import ModelUsageEvent, ProviderBinding
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def setup(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    return identity, trip, AdmissionService(database, catalog), catalog


def start(service, identity, trip, provider=None, **options):
    return service.start(
        identity,
        trip.id,
        "start",
        "synthetic",
        1,
        provider or ProviderBinding(provider="gemini", model=GEMINI_MODEL),
        "a" * 64,
        50,
        datetime.now(UTC),
        options.get("policy", policy()),
    )


def test_provider_admission_replays_atomically_and_refuses_fixture_rebinding(database):
    identity, trip, service, catalog = setup(database)
    binding, admission, created = start(service, identity, trip)
    assert created
    replay, same, created = start(service, identity, trip)
    assert not created
    assert replay == binding and same["id"] == admission["id"]
    with pytest.raises(DomainError, match="PROVIDER_CONFLICT"):
        start(
            service,
            identity,
            trip,
            ProviderBinding(provider="openrouter", model="vendor/model:free"),
        )
    with pytest.raises(DomainError, match="PROVIDER_CONFLICT"):
        PlanningService(database, catalog).start(
            identity, trip.id, "start", "synthetic", 1
        )
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM agent_runs").fetchone()["n"]
            == 1
        )
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM quota_reservations"
            ).fetchone()["n"]
            == 1
        )
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM agent_invocations"
            ).fetchone()["n"]
            == 1
        )


def test_failed_admission_rolls_back_run_reservation_and_binding(database):
    identity, trip, service, _ = setup(database)
    with pytest.raises(DomainError, match="LIVE_DISABLED"):
        start(
            service,
            identity,
            trip,
            policy=policy().model_copy(update={"enabled": False}),
        )
    with database.transaction() as connection:
        for table in (
            "agent_runs",
            "quota_reservations",
            "agent_invocations",
            "planning_executions",
        ):
            assert (
                connection.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]
                == 0
            )


def test_call_start_ack_never_authorizes_repeat_and_usage_is_immutable(database):
    identity, trip, service, _ = setup(database)
    binding, admission, _ = start(service, identity, trip)
    admission_id = str(admission["id"])
    assert service.account(binding, admission_id, "call-1") is True
    assert service.account(binding, admission_id, "call-1") is False
    event = ModelUsageEvent.model_validate(
        {
            "kind": "model-call-usage",
            "callId": "call-1",
            "usage": {"promptTokens": 10, "outputTokens": 5, "totalTokens": 15},
        }
    )
    assert service.account(binding, admission_id, event) is True
    assert service.account(binding, admission_id, event) is False
    changed = event.model_copy(update={"usage": None})
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        service.account(binding, admission_id, changed)
    for index in range(2, 8):
        assert service.account(binding, admission_id, f"call-{index}")
    with pytest.raises(DomainError, match="MODEL_CALL_LIMIT"):
        service.account(binding, admission_id, "call-8")


def test_expired_reservation_rejects_usage_callback(database):
    identity, trip, service, _ = setup(database)
    binding, admission, _ = start(service, identity, trip)
    service.account(binding, str(admission["id"]), "call")
    with database.transaction() as connection:
        connection.execute(
            "UPDATE quota_reservations SET "
            "reserved_at=clock_timestamp()-interval '2 minutes', "
            "expires_at=clock_timestamp()-interval '1 second'"
        )
    event = ModelUsageEvent(kind="model-call-usage", callId="call", usage=None)
    with pytest.raises(DomainError, match="ADMISSION_NOT_ACTIVE"):
        service.account(binding, str(admission["id"]), event)
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT status FROM model_calls").fetchone()["status"]
            == "started"
        )


def test_unknown_usage_settlement_after_owner_expiry_keeps_original_cost(database):
    identity, trip, service, _ = setup(database)
    binding, admission, _ = start(service, identity, trip)
    admission_id = str(admission["id"])
    service.account(binding, admission_id, "unknown")
    with database.transaction() as connection:
        connection.execute(
            "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second'"
        )
    settled = service.settle(binding, admission_id, 0, datetime.now(UTC))
    assert settled.actualCostMicros is None
    assert settled.chargedCostMicros == 50
    assert service.settle(binding, admission_id, 0, datetime.now(UTC)) == settled


def test_completed_usage_settlement_is_immutable_and_fences_late_callback(database):
    identity, trip, service, _ = setup(database)
    binding, admission, _ = start(service, identity, trip)
    admission_id = str(admission["id"])
    service.account(binding, admission_id, "call")
    event = ModelUsageEvent.model_validate(
        {
            "kind": "model-call-usage",
            "callId": "call",
            "usage": {"promptTokens": 10, "outputTokens": 5, "totalTokens": 15},
        }
    )
    service.account(binding, admission_id, event)
    settled = service.settle(binding, admission_id, 10, datetime.now(UTC))
    assert settled.chargedCostMicros == 10
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        service.settle(binding, admission_id, 0, datetime.now(UTC))
    with pytest.raises(DomainError, match="ADMISSION_NOT_ACTIVE"):
        service.account(binding, admission_id, "late")


def pending_admitted(database, binding, catalog):
    # Construct the durable precondition for the receipt-only admission tests.
    with database.transaction() as connection:
        trip = trips.get_trip(connection, binding.ownerId, binding.tripId, lock=True)
        proposal_id, draft = trips.save_proposal(
            connection,
            trip,
            [{"kind": "move", "entryId": "tour", "day": 3, "slot": "morning"}],
            catalog,
        )
        validation = Evidence(
            binding=binding,
            kind="validation",
            origin="validation",
            snapshot=trip.snapshot,
            draft=draft,
        )
        proposed = Evidence(
            binding=binding,
            kind="proposal",
            origin="proposal",
            snapshot=trip.snapshot,
            draft=draft,
            validation_ref=validation.id,
        )
        interrupt = planning.bind_proposal(
            connection, binding.tripId, binding.runId, proposal_id, "proposal"
        )
        answer = compile_answer(
            {
                "version": "1",
                "answer": {"kind": "proposal", "evidenceRef": proposed.id},
            },
            Compilation(binding, "proposal", (validation, proposed)),
        )
        planning.finish_run(
            connection, binding.tripId, binding.runId, answer, awaiting=True
        )
        return interrupt


@pytest.mark.parametrize("accepted", [True, False])
def test_zero_model_resume_after_seven_calls_and_exhausted_budget(database, accepted):
    identity, trip, service, catalog = setup(database)
    binding, admission, _ = start(service, identity, trip, policy=policy(50))
    admission_id = str(admission["id"])
    for index in range(7):
        call = f"call-{index}"
        service.account(binding, admission_id, call)
        service.account(
            binding,
            admission_id,
            ModelUsageEvent.model_validate(
                {
                    "kind": "model-call-usage",
                    "callId": call,
                    "usage": {"promptTokens": 1, "outputTokens": 1, "totalTokens": 2},
                }
            ),
        )
    interrupt = pending_admitted(database, binding, catalog)
    service.settle(binding, admission_id, 50, datetime.now(UTC))
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    result = service.resume(
        binding,
        interrupt,
        accepted,
        provider,
        "a" * 64,
        datetime.now(UTC),
        policy(50),
        event_request_id=str(uuid4()),
    )
    assert result["receipt"] == {
        "status": "applied" if accepted else "rejected",
        "version": 2 if accepted else 1,
    }
    assert (
        service.resume(
            binding,
            interrupt,
            accepted,
            provider,
            "a" * 64,
            datetime.now(UTC),
            policy(50),
            event_request_id=str(uuid4()),
        )
        == result
    )
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()["n"]
            == 7
        )
        assert connection.execute(
            "SELECT max_cost_micros,prior_model_calls,status "
            "FROM agent_invocations WHERE kind='resume'"
        ).fetchone() == {
            "max_cost_micros": 0,
            "prior_model_calls": 7,
            "status": "settled",
        }
        assert (
            connection.execute("SELECT lease_expires_at FROM agent_runs").fetchone()[
                "lease_expires_at"
            ]
            is None
        )


def test_disabled_resume_rolls_back_reservation_and_decision(database):
    identity, trip, service, catalog = setup(database)
    binding, admission, _ = start(service, identity, trip)
    interrupt = pending_admitted(database, binding, catalog)
    service.settle(binding, str(admission["id"]), None, datetime.now(UTC))
    with pytest.raises(DomainError, match="LIVE_DISABLED"):
        service.resume(
            binding,
            interrupt,
            True,
            ProviderBinding(provider="gemini", model=GEMINI_MODEL),
            "a" * 64,
            datetime.now(UTC),
            policy().model_copy(update={"enabled": False}),
            event_request_id=str(uuid4()),
        )
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM quota_reservations"
            ).fetchone()["n"]
            == 1
        )
        assert connection.execute(
            "SELECT status,decision FROM agent_runs"
        ).fetchone() == {"status": "awaiting_confirmation", "decision": None}
