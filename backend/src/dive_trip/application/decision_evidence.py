"""Read immutable product receipts, independently of today's trip version."""

from typing import Any, Self

from psycopg import Connection
from pydantic import model_validator

from dive_trip.modules.planning.answer_contract import (
    AcceptedAnswer,
    Receipt,
    ReceiptBody,
)
from dive_trip.modules.planning.evidence import Binding, hash_tuple
from dive_trip.modules.planning.public_events import Event
from dive_trip.modules.trips.transactions import TripView, view
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import WireModel


class CommittedDecision(WireModel):
    receipt: Receipt
    answer: AcceptedAnswer

    @model_validator(mode="after")
    def consistent(self) -> Self:
        body = self.answer.body
        if (
            not isinstance(body, ReceiptBody)
            or body.status != self.receipt.status
            or body.version != self.receipt.version
            or len(self.answer.evidenceRefs) != 1
        ):
            raise ValueError("DECISION_ANSWER_MISMATCH")
        return self


def read_decision_evidence(
    connection: Connection[dict[str, Any]], binding: Binding
) -> CommittedDecision | None:
    row = connection.execute(
        "SELECT r.status,r.base_version,r.decision,r.interrupt_id,r.proposal_id,"
        "e.committed_receipt,p.trip_id AS proposal_trip,"
        "p.base_version AS proposal_base,"
        "p.status AS proposal_status,p.rejection_version,p.draft,"
        "m.operation,m.payload_hash,m.trip_id AS receipt_trip,m.response "
        "FROM agent_runs r JOIN trips t ON t.id=r.trip_id "
        "JOIN planning_executions e ON e.run_id=r.id "
        "LEFT JOIN proposals p ON p.id=r.proposal_id "
        "LEFT JOIN mutation_receipts m ON m.owner_id=t.owner_id "
        "AND m.request_id='temporal-resume:'||r.id::text "
        "WHERE r.id=%s AND r.trip_id=%s AND t.owner_id=%s",
        (binding.runId, binding.tripId, binding.ownerId),
    ).fetchone()
    if row is None or row["base_version"] != binding.baseVersion:
        raise DomainError("EVIDENCE_DECISION_BINDING")
    if row["decision"] is None:
        if row["committed_receipt"] is not None or row["operation"] is not None:
            raise DomainError("EVIDENCE_UNCOMMITTED_DECISION")
        return None
    try:
        result = CommittedDecision.model_validate(row["committed_receipt"])
        if (
            row["status"] != "succeeded"
            or result.answer.runId != binding.runId
            or str(row["proposal_trip"]) != binding.tripId
            or row["proposal_base"] != binding.baseVersion
            or row["operation"] != "apply"
            or row["payload_hash"]
            != hash_tuple([binding.runId, row["interrupt_id"], row["decision"]])
        ):
            raise ValueError("DECISION_BINDING")
        if row["decision"]:
            version = binding.baseVersion + 1
            snapshot = connection.execute(
                "SELECT snapshot FROM trip_versions WHERE trip_id=%s AND version=%s",
                (binding.tripId, version),
            ).fetchone()
            if (
                row["proposal_status"] != "applied"
                or result.receipt != Receipt(status="applied", version=version)
                or str(row["receipt_trip"]) != binding.tripId
                or snapshot is None
                or snapshot["snapshot"] != row["draft"]["next"]
                or TripView.model_validate(row["response"])
                != view(binding.tripId, version, snapshot["snapshot"])
            ):
                raise ValueError("APPLY_RECEIPT")
        elif (
            row["proposal_status"] != "rejected"
            or row["rejection_version"] is None
            or row["rejection_version"] < binding.baseVersion
            or result.receipt
            != Receipt(status="rejected", version=row["rejection_version"])
            or row["response"] is not None
            or row["receipt_trip"] is not None
        ):
            raise ValueError("REJECTION_RECEIPT")
        # Confirmation persists exactly lifecycle / immutable receipt / lifecycle
        # in its product transaction. Do not infer this from current_version.
        events = connection.execute(
            "SELECT event FROM agent_run_events WHERE run_id=%s AND sequence >= "
            "(SELECT max(sequence) FROM agent_run_events WHERE run_id=%s "
            "AND event->>'type'='RUN_STARTED') ORDER BY sequence LIMIT 4",
            (binding.runId, binding.runId),
        ).fetchall()
        phase = [
            Event.validate_python(event["event"]).model_dump(
                mode="json", exclude_unset=True
            )
            for event in events
        ]
        if (
            len(phase) != 3
            or phase[0]["type"] != "RUN_STARTED"
            or phase[0]["threadId"] != binding.tripId
            or phase[1]
            != {
                "type": "CUSTOM",
                "name": "dive_trip.answer.v1",
                "value": result.answer.wire(),
            }
            or phase[2]
            != {
                "type": "RUN_FINISHED",
                "threadId": binding.tripId,
                "runId": phase[0]["runId"],
                "outcome": {"type": "success"},
            }
        ):
            raise ValueError("DECISION_EVENTS")
        return result
    except (ValueError, KeyError, TypeError):
        raise DomainError("EVIDENCE_DECISION_INVALID") from None
