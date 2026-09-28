"""Planning's public transaction operations; no identity or trip-table access."""

import re
from typing import Any
from uuid import uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.platform.errors import DomainError

from .answer_contract import AcceptedAnswer
from .evidence import hash_tuple
from .public_events import parse_event

ConnectionType = Connection[dict[str, Any]]


def expired_runs(connection: ConnectionType, trip_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT id,base_version FROM agent_runs WHERE trip_id=%s "
        "AND executor='temporal-v1' AND status='running' "
        "AND lease_expires_at<=clock_timestamp() ORDER BY id FOR UPDATE",
        (trip_id,),
    ).fetchall()


def deletion_runs(connection: ConnectionType, trip_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT r.id,r.executor,r.status,e.workflow_id FROM agent_runs r "
        "LEFT JOIN planning_executions e ON e.run_id=r.id "
        "WHERE r.trip_id=%s ORDER BY r.id FOR UPDATE OF r",
        (trip_id,),
    ).fetchall()
    if any(
        row["executor"] not in ("temporal-v1", "adk")
        or row["executor"] == "temporal-v1"
        and not row["workflow_id"]
        for row in rows
    ):
        raise DomainError("UNSUPPORTED_EXECUTOR")
    return rows


def fence_deletion(connection: ConnectionType, trip_id: str) -> None:
    connection.execute(
        "UPDATE agent_runs SET status='interrupted',lease_expires_at=NULL "
        "WHERE trip_id=%s AND status IN ('running','awaiting_confirmation')",
        (trip_id,),
    )


def run_views(
    connection: ConnectionType,
    trip_id: str,
    run_id: str | None = None,
    *,
    after_sequence: int = 0,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT * FROM agent_runs WHERE trip_id=%s "
        "AND (%s::uuid IS NULL OR id=%s::uuid) ORDER BY created_at,id",
        (trip_id, run_id, run_id),
    ).fetchall()
    result = []
    for row in rows:
        run_id = str(row["id"])
        events = []
        if row["answer_contract_version"] == 1:
            events = [
                {
                    "sequence": event["sequence"],
                    "event": parse_event(event["event"], trip_id, run_id),
                }
                for event in connection.execute(
                    "SELECT sequence,event FROM agent_run_events "
                    "WHERE run_id=%s AND sequence>%s ORDER BY sequence",
                    (run_id, after_sequence),
                ).fetchall()
            ]
        result.append(
            {
                "id": run_id,
                "tripId": trip_id,
                "requestId": row["request_id"],
                "baseVersion": row["base_version"],
                "message": row["message"],
                "status": row["status"],
                "events": events,
                "proposalId": str(row["proposal_id"]) if row["proposal_id"] else None,
                "interruptId": row["interrupt_id"],
                "decision": row["decision"],
                "answerContractVersion": row["answer_contract_version"] or 0,
                "executor": row["executor"],
            }
        )
    return result


def workflow_identity(connection: ConnectionType, workflow_id: str) -> tuple[str, str]:
    row = connection.execute(
        """
        SELECT r.id,r.trip_id FROM agent_runs r
        JOIN planning_executions e ON e.run_id=r.id
        WHERE e.workflow_id=%s AND r.executor='temporal-v1'
        """,
        (workflow_id,),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return str(row["trip_id"]), str(row["id"])


def tool_calls(connection: ConnectionType, run_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT * FROM planning_tool_calls WHERE run_id=%s ORDER BY ordinal", (run_id,)
    ).fetchall()


def consume_final_tool(
    connection: ConnectionType, trip_id: str, run_id: str, call_id: str
) -> None:
    row = require_run(connection, trip_id, run_id, active=True)
    if row["tool_steps"] >= 6 or row["final_call_id"] is not None:
        raise DomainError("AGENT_TOOL_LIMIT")
    connection.execute(
        "UPDATE planning_executions SET tool_steps=tool_steps+1,final_call_id=%s "
        "WHERE run_id=%s",
        (call_id, run_id),
    )


def require_run(
    connection: ConnectionType, trip_id: str, run_id: str, *, active: bool = False
) -> dict[str, Any]:
    row = connection.execute(
        """
        SELECT r.*,e.workflow_id,e.workflow_started,e.execution_run_id,
        e.evaluation_fault,e.catalog_snapshot,
        e.model_steps,e.tool_steps,e.latest_validation_call,e.final_call_id,e.committed_receipt,
        e.cancellation_requested,e.cancellation_delivered,
        r.lease_expires_at>clock_timestamp() AS lease_live
        FROM agent_runs r JOIN planning_executions e ON e.run_id=r.id
        WHERE r.id=%s AND r.trip_id=%s FOR UPDATE OF r,e
        """,
        (run_id, trip_id),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    if row["executor"] != "temporal-v1" or row["answer_contract_version"] != 1:
        raise DomainError("RUN_STATE_CONFLICT")
    if active and (row["status"] != "running" or not row["lease_live"]):
        raise DomainError("RUN_STATE_CONFLICT")
    return row


def bind_execution(connection: ConnectionType, run_id: str, execution_id: str) -> None:
    connection.execute(
        "UPDATE planning_executions SET execution_run_id=%s WHERE run_id=%s",
        (execution_id, run_id),
    )


def start_run(
    connection: ConnectionType,
    trip_id: str,
    version: int,
    request_id: str,
    message: str,
    base_version: int,
    catalog: list[CatalogItem],
    *,
    evaluation_fault: str | None = None,
) -> tuple[dict[str, Any], bool]:
    if evaluation_fault is not None:
        schema = connection.execute("SELECT current_schema() AS name").fetchone()
        if (
            evaluation_fault != "catalog-timeout"
            or schema is None
            or not re.fullmatch(r"python_test_[a-f0-9]{32}", schema["name"])
        ):
            raise DomainError("EVALUATION_CONTEXT_REQUIRED")
    if (
        not isinstance(request_id, str)
        or not request_id.strip()
        or len(request_id) > 128
        or "\0" in request_id
        or not isinstance(message, str)
        or not message.strip()
        or len(message) > 4000
        or "\0" in message
    ):
        raise DomainError("INVALID_RUN")
    payload_hash = hash_tuple([trip_id, message, base_version])
    previous = connection.execute(
        "SELECT * FROM agent_runs WHERE trip_id=%s AND request_id=%s",
        (trip_id, request_id),
    ).fetchone()
    if previous is not None:
        if (
            previous["executor"] != "temporal-v1"
            or previous["answer_contract_version"] != 1
        ):
            raise DomainError("RUN_STATE_CONFLICT")
        if previous["payload_hash"] != payload_hash:
            raise DomainError("IDEMPOTENCY_CONFLICT")
        stored = require_run(connection, trip_id, str(previous["id"]))
        if stored["evaluation_fault"] != evaluation_fault:
            raise DomainError("IDEMPOTENCY_CONFLICT")
        return stored, False
    if version != base_version:
        raise DomainError("STALE_VERSION")
    if (
        connection.execute(
            """
        SELECT id FROM agent_runs WHERE trip_id=%s
        AND executor='temporal-v1' AND status IN ('running','awaiting_confirmation')
        """,
            (trip_id,),
        ).fetchone()
        is not None
    ):
        raise DomainError("RUN_ACTIVE")
    identity = str(uuid4())
    connection.execute(
        """
        INSERT INTO agent_runs(id,trip_id,request_id,payload_hash,base_version,message,
        status,lease_expires_at,answer_contract_version,executor)
        VALUES(%s,%s,%s,%s,%s,%s,'running',
               clock_timestamp()+interval '60 seconds',1,'temporal-v1')
        """,
        (identity, trip_id, request_id, payload_hash, base_version, message),
    )
    connection.execute(
        """
        INSERT INTO planning_executions(
          run_id,workflow_id,catalog_snapshot,evaluation_fault)
        VALUES(%s,%s,%s,%s)
        """,
        (
            identity,
            f"dive-trip-v1:{identity}",
            Jsonb([item.model_dump(mode="json") for item in catalog]),
            evaluation_fault,
        ),
    )
    _append_event(
        connection,
        identity,
        {"type": "RUN_STARTED", "threadId": trip_id, "runId": request_id},
    )
    return require_run(connection, trip_id, identity), True


def acknowledge_workflow(connection: ConnectionType, trip_id: str, run_id: str) -> None:
    require_run(connection, trip_id, run_id)
    connection.execute(
        "UPDATE planning_executions SET workflow_started=true WHERE run_id=%s",
        (run_id,),
    )


def acknowledge_decision(connection: ConnectionType, trip_id: str, run_id: str) -> None:
    row = require_run(connection, trip_id, run_id)
    if row["status"] != "succeeded" or row["committed_receipt"] is None:
        raise DomainError("RUN_STATE_CONFLICT")
    connection.execute(
        "UPDATE planning_executions SET decision_delivered=true WHERE run_id=%s",
        (run_id,),
    )


def acknowledge_cancellation(
    connection: ConnectionType, trip_id: str, run_id: str
) -> None:
    row = require_run(connection, trip_id, run_id)
    if row["status"] != "interrupted" or not row["cancellation_requested"]:
        raise DomainError("RUN_STATE_CONFLICT")
    connection.execute(
        "UPDATE planning_executions SET cancellation_delivered=true WHERE run_id=%s",
        (run_id,),
    )


def _append_event(
    connection: ConnectionType, run_id: str, event: dict[str, Any]
) -> None:
    connection.execute(
        """
        INSERT INTO agent_run_events(run_id,sequence,event)
        SELECT %s,COALESCE(max(sequence),0)+1,%s FROM agent_run_events WHERE run_id=%s
        """,
        (run_id, Jsonb(event), run_id),
    )


def _persist_answer(
    connection: ConnectionType, run_id: str, answer: AcceptedAnswer
) -> None:
    if answer.runId != run_id:
        raise DomainError("INVALID_RUN_EVENT")
    row = connection.execute(
        """
        SELECT event FROM agent_run_events WHERE run_id=%s
        AND event->>'type'='CUSTOM' AND event->>'name'='dive_trip.answer.v1'
        AND event->'value'->>'answerId'=%s
        """,
        (run_id, answer.answerId),
    ).fetchone()
    event = {"type": "CUSTOM", "name": "dive_trip.answer.v1", "value": answer.wire()}
    if row is not None:
        if row["event"] != event:
            raise DomainError("INVALID_RUN_EVENT")
        return
    _append_event(connection, run_id, event)


def start_model_step(
    connection: ConnectionType, trip_id: str, run_id: str, activity_id: str
) -> None:
    row = require_run(connection, trip_id, run_id, active=True)
    if (
        connection.execute(
            "SELECT activity_id FROM planning_model_steps "
            "WHERE run_id=%s AND activity_id=%s",
            (run_id, activity_id),
        ).fetchone()
        is not None
    ):
        # Replay completed history; activity redispatch cannot call the provider.
        raise DomainError("MODEL_DISPATCH_CONFLICT")
    if (
        row["model_steps"] >= 7
        or row["proposal_id"] is not None
        or row["final_call_id"] is not None
    ):
        raise DomainError("MODEL_CALL_LIMIT")
    if (
        connection.execute(
            "SELECT activity_id FROM planning_model_steps "
            "WHERE run_id=%s AND arguments_rejected",
            (run_id,),
        ).fetchone()
        is not None
    ):
        raise DomainError("MODEL_GENERATION_DISABLED")
    if (
        connection.execute(
            "SELECT activity_id FROM planning_model_steps "
            "WHERE run_id=%s AND NOT completed",
            (run_id,),
        ).fetchone()
        is not None
    ):
        raise DomainError("MODEL_UNKNOWN_USAGE_STOP")
    ordinal = row["model_steps"] + 1
    connection.execute(
        "INSERT INTO planning_model_steps(run_id,activity_id,ordinal) VALUES(%s,%s,%s)",
        (run_id, activity_id, ordinal),
    )
    connection.execute(
        "UPDATE planning_executions SET model_steps=%s WHERE run_id=%s",
        (ordinal, run_id),
    )


def complete_model_step(
    connection: ConnectionType, trip_id: str, run_id: str, activity_id: str
) -> None:
    require_run(connection, trip_id, run_id, active=True)
    result = connection.execute(
        """
        UPDATE planning_model_steps SET completed=true
        WHERE run_id=%s AND activity_id=%s AND NOT completed RETURNING activity_id
        """,
        (run_id, activity_id),
    ).fetchone()
    if result is None:
        raise DomainError("MODEL_DISPATCH_CONFLICT")


def mark_argument_rejection(
    connection: ConnectionType, run_id: str, activity_id: str
) -> None:
    result = connection.execute(
        "UPDATE planning_model_steps SET arguments_rejected=true "
        "WHERE run_id=%s AND activity_id=%s AND completed RETURNING activity_id",
        (run_id, activity_id),
    ).fetchone()
    if result is None:
        raise DomainError("MODEL_DISPATCH_CONFLICT")


def has_argument_rejection(
    connection: ConnectionType, run_id: str, activity_id: str
) -> bool:
    return (
        connection.execute(
            "SELECT activity_id FROM planning_model_steps WHERE run_id=%s "
            "AND activity_id=%s AND completed AND arguments_rejected",
            (run_id, activity_id),
        ).fetchone()
        is not None
    )


def start_tool(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    call_id: str,
    name: str,
    args: dict[str, Any],
) -> None:
    row = require_run(connection, trip_id, run_id, active=True)
    if (
        row["tool_steps"] >= 6
        or row["proposal_id"] is not None
        or row["final_call_id"] is not None
    ):
        raise DomainError("AGENT_TOOL_LIMIT")
    if (
        connection.execute(
            "SELECT call_id FROM planning_tool_calls WHERE run_id=%s AND call_id=%s",
            (run_id, call_id),
        ).fetchone()
        is not None
    ):
        raise DomainError("AGENT_TOOL_CONFLICT")
    ordinal = row["tool_steps"] + 1
    connection.execute(
        """
        INSERT INTO planning_tool_calls(run_id,call_id,name,ordinal,args)
        VALUES(%s,%s,%s,%s,%s)
        """,
        (run_id, call_id, name, ordinal, Jsonb(args)),
    )
    connection.execute(
        "UPDATE planning_executions SET tool_steps=%s WHERE run_id=%s",
        (ordinal, run_id),
    )
    if name == "validate_changes":
        connection.execute(
            "UPDATE planning_executions SET latest_validation_call=%s WHERE run_id=%s",
            (call_id, run_id),
        )
    _append_event(
        connection,
        run_id,
        {"type": "TOOL_CALL_START", "toolCallId": call_id, "toolCallName": name},
    )


def complete_tool(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    call_id: str,
    result: dict[str, Any],
    validation_id: str | None = None,
) -> None:
    require_run(connection, trip_id, run_id, active=True)
    row = connection.execute(
        """
        UPDATE planning_tool_calls SET completed=true,result=%s,validation_id=%s
        WHERE run_id=%s AND call_id=%s AND NOT completed RETURNING call_id
        """,
        (Jsonb(result), validation_id, run_id, call_id),
    ).fetchone()
    if row is None:
        raise DomainError("AGENT_TOOL_CONFLICT")
    _append_event(connection, run_id, {"type": "TOOL_CALL_END", "toolCallId": call_id})
    _append_event(
        connection,
        run_id,
        {
            "type": "TOOL_CALL_RESULT",
            "messageId": "result:" + hash_tuple([run_id, call_id]),
            "toolCallId": call_id,
            "role": "tool",
            "content": "{}",
        },
    )


def latest_validation(
    connection: ConnectionType, trip_id: str, run_id: str, validation_id: str
) -> dict[str, Any]:
    row = require_run(connection, trip_id, run_id, active=True)
    result = connection.execute(
        """
        SELECT * FROM planning_tool_calls WHERE run_id=%s AND call_id=%s
        AND name='validate_changes' AND completed AND validation_id=%s
        """,
        (run_id, row["latest_validation_call"], validation_id),
    ).fetchone()
    if result is None:
        raise DomainError("AGENT_INVALID_VALIDATION")
    return result


def bind_proposal(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    proposal_id: str,
    call_id: str,
) -> str:
    row = require_run(connection, trip_id, run_id, active=True)
    if row["proposal_id"] is not None:
        raise DomainError("RUN_STATE_CONFLICT")
    interrupt = str(uuid4())
    connection.execute(
        """
        UPDATE agent_runs SET proposal_id=%s,proposal_tool_call_id=%s,interrupt_id=%s
        WHERE id=%s
        """,
        (proposal_id, call_id, interrupt, run_id),
    )
    return interrupt


def finish_run(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    answer: AcceptedAnswer,
    *,
    awaiting: bool = False,
) -> None:
    row = require_run(connection, trip_id, run_id, active=True)
    if awaiting and (row["proposal_id"] is None or row["interrupt_id"] is None):
        raise DomainError("RUN_STATE_CONFLICT")
    _persist_answer(connection, run_id, answer)
    connection.execute(
        "UPDATE agent_runs SET status=%s,lease_expires_at=NULL WHERE id=%s",
        ("awaiting_confirmation" if awaiting else "succeeded", run_id),
    )
    outcome: dict[str, Any] = {"type": "success"}
    if awaiting:
        outcome = {
            "type": "interrupt",
            "interrupts": [{"id": row["interrupt_id"], "reason": "approval"}],
        }
    _append_event(
        connection,
        run_id,
        {
            "type": "RUN_FINISHED",
            "threadId": trip_id,
            "runId": row["request_id"],
            "outcome": outcome,
        },
    )


def require_decision(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    interrupt_id: str,
    accepted: bool,
) -> dict[str, Any]:
    row = require_run(connection, trip_id, run_id)
    if type(accepted) is not bool or row["interrupt_id"] != interrupt_id:
        raise DomainError("RUN_STATE_CONFLICT")
    if row["decision"] is not None:
        if (
            row["decision"] != accepted
            or row["status"] != "succeeded"
            or row["committed_receipt"] is None
        ):
            raise DomainError("RUN_STATE_CONFLICT")
        return row
    if row["status"] != "awaiting_confirmation" or row["proposal_id"] is None:
        raise DomainError("RUN_STATE_CONFLICT")
    return row


def finish_decision(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    interrupt_id: str,
    accepted: bool,
    receipt: dict[str, Any],
    answer: AcceptedAnswer,
    event_request_id: str,
) -> None:
    row = require_decision(connection, trip_id, run_id, interrupt_id, accepted)
    if row["committed_receipt"] is not None:
        raise DomainError("RUN_STATE_CONFLICT")
    _append_event(
        connection,
        run_id,
        {"type": "RUN_STARTED", "threadId": trip_id, "runId": event_request_id},
    )
    _persist_answer(connection, run_id, answer)
    connection.execute(
        "UPDATE planning_executions SET committed_receipt=%s WHERE run_id=%s",
        (Jsonb(receipt), run_id),
    )
    connection.execute(
        "UPDATE agent_runs SET status='succeeded',decision=%s WHERE id=%s",
        (accepted, run_id),
    )
    _append_event(
        connection,
        run_id,
        {
            "type": "RUN_FINISHED",
            "threadId": trip_id,
            "runId": event_request_id,
            "outcome": {"type": "success"},
        },
    )


def accepted_answers(connection: ConnectionType, run_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT event->'value' AS answer FROM agent_run_events WHERE run_id=%s "
        "AND event->>'type'='CUSTOM' AND event->>'name'='dive_trip.answer.v1' "
        "ORDER BY sequence",
        (run_id,),
    ).fetchall()
    return [AcceptedAnswer.model_validate(row["answer"]).wire() for row in rows]


def end_failed(
    connection: ConnectionType,
    trip_id: str,
    run_id: str,
    answer: AcceptedAnswer,
    *,
    interrupted: bool = False,
) -> dict[str, Any]:
    row = require_run(connection, trip_id, run_id)
    if row["status"] != "running":
        return row
    _persist_answer(connection, run_id, answer)
    status = "interrupted" if interrupted else "failed"
    if interrupted:
        connection.execute(
            "UPDATE planning_executions SET cancellation_requested=true,"
            "next_delivery_at=clock_timestamp() WHERE run_id=%s",
            (run_id,),
        )
    connection.execute(
        "UPDATE agent_runs SET status=%s,lease_expires_at=NULL WHERE id=%s",
        (status, run_id),
    )
    _append_event(
        connection,
        run_id,
        {
            "type": "RUN_ERROR",
            "code": "AGENT_INTERRUPTED" if interrupted else "AGENT_FAILED",
            "message": "執行已中止" if interrupted else "執行失敗",
        },
    )
    return require_run(connection, trip_id, run_id)
