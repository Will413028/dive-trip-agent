"""Apply a decision inside an already authenticated, locked application transaction."""

from typing import Any

from psycopg import Connection

from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.answer_contract import AnswerPlan, EvidencePlan, Receipt
from dive_trip.modules.planning.compiler import compile_answer
from dive_trip.modules.planning.evidence import Binding, Compilation, Evidence
from dive_trip.modules.trips import transactions as trips
from dive_trip.platform.errors import DomainError


def commit_confirmation(
    connection: Connection[dict[str, Any]],
    binding: Binding,
    trip: trips.TripView,
    interrupt_id: str,
    accepted: bool,
    request_id: str,
    payload_hash: str,
    mutation: dict[str, Any],
    event_request_id: str,
) -> dict[str, Any]:
    row = planning.require_decision(
        connection, binding.tripId, binding.runId, interrupt_id, accepted
    )
    if row["base_version"] != binding.baseVersion or trip.id != binding.tripId:
        raise DomainError("RUN_STATE_CONFLICT")
    if row["committed_receipt"] is not None:
        return dict(row["committed_receipt"])
    if accepted:
        result = trips.mutate_trip(
            connection,
            binding.ownerId,
            trip,
            binding.baseVersion,
            request_id,
            "apply",
            str(row["proposal_id"]),
            mutation,
            payload_hash,
        )
        receipt = Receipt(status="applied", version=result.version)
    else:
        trips.reject_proposal(connection, trip, str(row["proposal_id"]))
        receipt = Receipt(status="rejected", version=trip.version)
    evidence = Evidence(
        binding=binding, kind="receipt", origin="committed-decision", receipt=receipt
    )
    answer = compile_answer(
        AnswerPlan(
            version="1", answer=EvidencePlan(kind="receipt", evidenceRef=evidence.id)
        ),
        Compilation(binding, "receipt-answer", (evidence,)),
    )
    committed = {"receipt": receipt.model_dump(mode="json"), "answer": answer.wire()}
    planning.finish_decision(
        connection,
        binding.tripId,
        binding.runId,
        interrupt_id,
        accepted,
        committed,
        answer,
        event_request_id,
    )
    return committed
