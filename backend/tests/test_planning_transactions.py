from uuid import uuid4

import pytest
from test_budget import snapshot
from test_trip_transactions import owner

from dive_trip.application.trips import TripService
from dive_trip.modules.planning.transactions import (
    complete_model_step,
    complete_tool,
    latest_validation,
    require_run,
    start_model_step,
    start_run,
    start_tool,
)
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def run(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    with database.transaction() as connection:
        row, created = start_run(
            connection,
            trip.id,
            1,
            "start",
            "合成測試",
            1,
            [entry.item for entry in trip.snapshot.entries],
        )
        assert created
    return identity, trip, str(row["id"])


def test_run_start_replays_without_new_executor_and_rejects_changed_payload(database):
    identity, trip, run_id = run(database)
    with database.transaction() as connection:
        row, created = start_run(connection, trip.id, 1, "start", "合成測試", 1, [])
        assert not created
        assert str(row["id"]) == run_id
        assert len(row["catalog_snapshot"]) == 3
        assert row["workflow_id"] == f"dive-trip-v1:{run_id}"
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        with database.transaction() as connection:
            start_run(connection, trip.id, 1, "start", "不同訊息", 1, [])
    with pytest.raises(DomainError, match="RUN_ACTIVE"):
        with database.transaction() as connection:
            start_run(connection, trip.id, 1, "other", "其他執行", 1, [])


def test_ambiguous_model_dispatch_cannot_be_reexecuted(database):
    _, trip, run_id = run(database)
    with database.transaction() as connection:
        start_model_step(connection, trip.id, run_id, "model-1")
    with pytest.raises(DomainError, match="MODEL_DISPATCH_CONFLICT"):
        with database.transaction() as connection:
            start_model_step(connection, trip.id, run_id, "model-1")
    with pytest.raises(DomainError, match="MODEL_UNKNOWN_USAGE_STOP"):
        with database.transaction() as connection:
            start_model_step(connection, trip.id, run_id, "new-activity")
    with database.transaction() as connection:
        complete_model_step(connection, trip.id, run_id, "model-1")
    with pytest.raises(DomainError, match="MODEL_DISPATCH_CONFLICT"):
        with database.transaction() as connection:
            start_model_step(connection, trip.id, run_id, "model-1")
    with database.transaction() as connection:
        assert require_run(connection, trip.id, run_id)["model_steps"] == 1


def test_new_unfinished_validation_invalidates_old_success(database):
    _, trip, run_id = run(database)
    validation_id = str(uuid4())
    with database.transaction() as connection:
        start_tool(
            connection,
            trip.id,
            run_id,
            "validate-1",
            "validate_changes",
            {"changes": []},
        )
        complete_tool(
            connection, trip.id, run_id, "validate-1", {"canApply": True}, validation_id
        )
        assert (
            latest_validation(connection, trip.id, run_id, validation_id)["call_id"]
            == "validate-1"
        )
    with database.transaction() as connection:
        start_tool(
            connection,
            trip.id,
            run_id,
            "validate-2",
            "validate_changes",
            {"changes": []},
        )
    with pytest.raises(DomainError, match="AGENT_INVALID_VALIDATION"):
        with database.transaction() as connection:
            latest_validation(connection, trip.id, run_id, validation_id)
    with database.transaction() as connection:
        complete_tool(connection, trip.id, run_id, "validate-2", {"canApply": False})
    with pytest.raises(DomainError, match="AGENT_INVALID_VALIDATION"):
        with database.transaction() as connection:
            latest_validation(connection, trip.id, run_id, validation_id)


def test_expired_lease_fences_late_results(database):
    _, trip, run_id = run(database)
    with database.transaction() as connection:
        start_model_step(connection, trip.id, run_id, "model")
        connection.execute(
            "UPDATE agent_runs SET "
            "lease_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=%s",
            (run_id,),
        )
    with pytest.raises(DomainError, match="RUN_STATE_CONFLICT"):
        with database.transaction() as connection:
            complete_model_step(connection, trip.id, run_id, "model")
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT completed FROM planning_model_steps WHERE run_id=%s", (run_id,)
            ).fetchone()["completed"]
            is False
        )
