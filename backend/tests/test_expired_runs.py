from datetime import UTC, datetime

import pytest
from test_budget import snapshot
from test_quota import policy
from test_trip_transactions import owner

from dive_trip.application.admission import AdmissionService
from dive_trip.application.planning import PlanningService
from dive_trip.application.run_queries import RunQueries
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.trips import TripService
from dive_trip.modules.usage.provider import GEMINI_MODEL
from dive_trip.modules.usage.public import ProviderBinding


@pytest.mark.parametrize("entry", ["read", "start"])
def test_acked_expired_fixture_is_recovered_without_worker(database, entry):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [])
    row, _ = service.start(identity, trip.id, "abandoned", "fixture:budget", 1)
    with database.transaction() as connection:
        connection.execute("UPDATE planning_executions SET workflow_started=true")
        connection.execute(
            "UPDATE agent_runs SET "
            "lease_expires_at=clock_timestamp()-interval '1 second'"
        )
    if entry == "read":
        view = RunQueries(database).get(identity, trip.id, str(row["id"]))
        assert view["status"] == "interrupted"
        assert view["events"][-1]["event"]["type"] == "RUN_ERROR"
    # New start itself must also recover; do not depend on a prior GET or worker.
    replacement, _ = service.start(
        identity, trip.id, "new-user-request", "fixture:budget", 1
    )
    assert replacement["id"] != row["id"]
    with database.transaction() as connection:
        old = connection.execute(
            "SELECT r.status,e.cancellation_requested FROM agent_runs r "
            "JOIN planning_executions e ON e.run_id=r.id WHERE r.id=%s",
            (row["id"],),
        ).fetchone()
        assert old == {"status": "interrupted", "cancellation_requested": True}
    # Repeated reads never append another failure answer.
    queries = RunQueries(database)
    assert queries.get(identity, trip.id, str(row["id"])) == queries.get(
        identity, trip.id, str(row["id"])
    )


def test_read_recovers_expired_provider_without_turning_unknown_into_zero(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    binding, _, _ = AdmissionService(database, []).start(
        identity,
        trip.id,
        "unknown",
        "fixture:budget",
        1,
        provider,
        "a" * 64,
        50,
        datetime.now(UTC),
        policy(),
    )
    service = PlanningService(database, [], accounting=RuntimeAccounting(provider))
    service.begin_model(binding, "unknown-model")
    with database.transaction() as connection:
        connection.execute("UPDATE planning_executions SET workflow_started=true")
        connection.execute(
            "UPDATE agent_runs SET "
            "lease_expires_at=clock_timestamp()-interval '1 second'"
        )
    assert (
        RunQueries(database).get(identity, trip.id, binding.runId)["status"]
        == "interrupted"
    )
    with database.transaction() as connection:
        assert connection.execute(
            "SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations"
        ).fetchone() == {"actual_cost_micros": None, "charged_cost_micros": 50}
        assert connection.execute(
            "SELECT status,usage FROM model_calls"
        ).fetchone() == {
            "status": "started",
            "usage": None,
        }
