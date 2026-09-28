from uuid import uuid4

import pytest
from test_planning_service import propose, setup_run

from dive_trip.application.decision_evidence import read_decision_evidence
from dive_trip.application.trips import TripService
from dive_trip.platform.errors import DomainError


def read(database, binding):
    with database.transaction() as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return read_decision_evidence(connection, binding)


@pytest.mark.parametrize("accepted", [True, False])
def test_product_decision_uses_immutable_receipt_after_later_versions(
    database, accepted
):
    service, binding = setup_run(database)
    pending = propose(service, binding)
    assert read(database, binding) is None
    committed = service.decide(
        binding, pending["interruptId"], accepted, event_request_id=str(uuid4())
    )
    evidence = read(database, binding)
    assert evidence.model_dump(mode="json") == committed
    # A later manual restore must not turn an accepted/rejected receipt unknown.
    TripService(database).mutate(
        binding.ownerId,
        binding.tripId,
        2 if accepted else 1,
        str(uuid4()),
        "restore",
        1,
    )
    assert read(database, binding) == evidence


@pytest.mark.parametrize(
    "tamper",
    [
        "receipt-hash",
        "receipt-trip",
        "receipt-response",
        "proposal-status",
        "proposal-snapshot",
        "projection",
        "lifecycle",
        "rejection-version",
    ],
)
def test_product_decision_rejects_independent_product_or_event_drift(database, tamper):
    service, binding = setup_run(database)
    pending = propose(service, binding)
    service.decide(
        binding,
        pending["interruptId"],
        tamper != "rejection-version",
        event_request_id=str(uuid4()),
    )
    assert read(database, binding) is not None
    mutations = {
        "receipt-hash": "UPDATE mutation_receipts SET payload_hash=repeat('0',64)",
        "receipt-trip": "UPDATE mutation_receipts SET trip_id=NULL",
        "receipt-response": "UPDATE mutation_receipts SET response=NULL",
        "proposal-status": "UPDATE proposals SET status='pending'",
        "proposal-snapshot": (
            "UPDATE proposals SET draft=jsonb_set(draft,'{next}', '{}')"
        ),
        "projection": (
            "DELETE FROM agent_run_events "
            "WHERE event->'value'->'body'->>'kind'='receipt'"
        ),
        "lifecycle": (
            "UPDATE agent_run_events SET event=jsonb_set(event,'{runId}', '\"wrong\"') "
            "WHERE sequence=(SELECT max(sequence) FROM agent_run_events)"
        ),
        "rejection-version": (
            "UPDATE proposals SET rejection_version=rejection_version+1"
        ),
    }
    with database.transaction() as connection:
        connection.execute(mutations[tamper])
    with pytest.raises(DomainError, match="EVIDENCE_DECISION_INVALID"):
        read(database, binding)
