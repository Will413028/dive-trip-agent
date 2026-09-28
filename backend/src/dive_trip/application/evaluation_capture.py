"""Private campaign inventory. Caller has joined all owned worker phases."""

from typing import Any

from pydantic import TypeAdapter

from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_storage import storage_fingerprint

from .usage_evidence import UsageEvidence, read_usage_evidence


def campaign_inventory(
    database: Database,
    owned_trips: set[str],
    evidence: dict[str, UsageEvidence],
    current_trip: str,
) -> dict[str, Any]:
    # Re-read prior evidence instead of trusting cumulative arithmetic or an
    # in-memory prior capture. This is not a cross-system atomic snapshot.
    for saved in evidence.values():
        if read_usage_evidence(database, saved.run, saved.provider) != saved:
            raise DomainError("EVALUATION_EVIDENCE_CHANGED")
    with database.transaction() as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        trips = connection.execute("SELECT id FROM trips").fetchall()
        runs = connection.execute(
            "SELECT id,trip_id,status,proposal_id,interrupt_id,decision "
            "FROM agent_runs ORDER BY id"
        ).fetchall()
        calls = connection.execute(
            "SELECT run_id,call_id,invocation_id FROM model_calls ORDER BY call_id"
        ).fetchall()
        invocations = connection.execute(
            "SELECT id,run_id,reservation_id FROM agent_invocations ORDER BY id"
        ).fetchall()
        reservations = connection.execute(
            "SELECT id,logical_run_id,charged_cost_micros FROM quota_reservations "
            "ORDER BY id"
        ).fetchall()
        daily = connection.execute("SELECT * FROM quota_daily_totals").fetchall()
        if (
            {str(row["id"]) for row in trips} != owned_trips
            or {str(row["id"]) for row in runs} != set(evidence)
            or any(str(row["trip_id"]) not in owned_trips for row in runs)
            or daily
            or {
                (str(row["run_id"]), row["call_id"], str(row["invocation_id"]))
                for row in calls
            }
            != {
                (run_id, call.event.callId, call.invocation_id)
                for run_id, saved in evidence.items()
                for call in saved.calls
            }
            or {
                (str(row["run_id"]), str(row["id"]), str(row["reservation_id"]))
                for row in invocations
            }
            != {
                (run_id, row.id, row.reservation_id)
                for run_id, saved in evidence.items()
                for row in saved.invocations
            }
            or {
                (str(row["logical_run_id"]), str(row["id"]), row["charged_cost_micros"])
                for row in reservations
            }
            != {
                (run_id, row.reservation_id, row.charged_cost_micros)
                for run_id, saved in evidence.items()
                for row in saved.invocations
            }
        ):
            raise DomainError("EVALUATION_INVENTORY_CHANGED")
        events = connection.execute(
            "SELECT e.run_id,e.sequence,e.event FROM agent_run_events e "
            "JOIN agent_runs r ON r.id=e.run_id WHERE r.trip_id=%s "
            "ORDER BY e.sequence",
            (current_trip,),
        ).fetchall()
        exported: dict[str, Any] = TypeAdapter(dict[str, Any]).dump_python(
            {
                "runs": [row for row in runs if str(row["trip_id"]) == current_trip],
                "events": events,
                "chargedMicros": sum(
                    row["charged_cost_micros"] for row in reservations
                ),
                "modelCalls": len(calls),
                "storageFingerprint": storage_fingerprint(connection),
            },
            mode="json",
        )
        return exported
