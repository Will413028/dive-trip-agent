"""Deposit persistence. Callers own the transaction; money commands are written
before PayPal is called and completed afterwards."""

import hashlib
from datetime import date
from typing import Any, Literal
from uuid import uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.platform.errors import DomainError

from .domain import (
    DiverPayment,
    DiverSettlement,
    Mandate,
    MandateCheck,
    RefundPolicy,
    SettlementFacts,
)
from .errors import DepositConflict

ConnectionType = Connection[dict[str, Any]]
CommandKind = Literal["authorize", "capture", "void", "refund"]
CommandStatus = Literal["succeeded", "rejected", "unknown"]
PaymentMethod = Literal["checkout", "test_card"]


def workspace_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def append(
    connection: ConnectionType, booking_id: str, kind: str, detail: dict[str, Any]
) -> None:
    connection.execute(
        "INSERT INTO deposit_timeline(booking_id,kind,detail) VALUES(%s,%s,%s)",
        (booking_id, kind, Jsonb(detail)),
    )


def create_booking(
    connection: ConnectionType,
    *,
    workspace: str,
    title: str,
    starts_on: date,
    site: tuple[float, float],
    policy: RefundPolicy,
    mandate: Mandate,
) -> str:
    booking_id = str(uuid4())
    connection.execute(
        "INSERT INTO deposit_bookings(id,workspace_hash,title,starts_on,trip_days,"
        "site_lat,site_lon,deposit_minor,policy,mandate) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            booking_id,
            workspace_hash(workspace),
            title,
            starts_on,
            policy.tripDays,
            site[0],
            site[1],
            policy.depositMinor,
            Jsonb(policy.model_dump(mode="json")),
            Jsonb(mandate.model_dump(mode="json")),
        ),
    )
    append(
        connection,
        booking_id,
        "booking_created",
        {"policyVersion": policy.version, "depositMinor": policy.depositMinor},
    )
    return booking_id


def booking(
    connection: ConnectionType, workspace: str, booking_id: str
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM deposit_bookings WHERE id=%s AND workspace_hash=%s",
        (booking_id, workspace_hash(workspace)),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return row


def policy_of(row: dict[str, Any]) -> RefundPolicy:
    return RefundPolicy.model_validate(row["policy"])


def mandate_of(row: dict[str, Any]) -> Mandate:
    return Mandate.model_validate(row["mandate"])


def join_diver(
    connection: ConnectionType, booking_id: str, name: str, *, seeded: bool
) -> str:
    """Add a diver once. The booking's own browser may rejoin under a name that still
    holds nothing, which resumes that diver's deposit instead of adding another."""
    diver_id = str(uuid4())
    inserted = connection.execute(
        "INSERT INTO deposit_divers(id,booking_id,display_name,seeded,state) "
        "VALUES(%s,%s,%s,%s,'pending') "
        "ON CONFLICT (booking_id,display_name) DO NOTHING RETURNING id",
        (diver_id, booking_id, name, seeded),
    ).fetchone()
    if inserted is not None:
        append(
            connection, booking_id, "diver_joined", {"diverId": diver_id, "name": name}
        )
        return diver_id
    existing = connection.execute(
        "SELECT id,seeded,state FROM deposit_divers "
        "WHERE booking_id=%s AND display_name=%s",
        (booking_id, name),
    ).fetchone()
    assert existing is not None
    if seeded or existing["seeded"] or existing["state"] != "pending":
        raise DepositConflict("DEPOSIT_NAME_TAKEN")
    return str(existing["id"])


def open_hold_attempt(
    connection: ConnectionType,
    booking_id: str,
    diver_id: str,
    method: PaymentMethod,
    *,
    command_id: str | None = None,
    order_id: str | None = None,
) -> dict[str, Any]:
    """Record a new attempt to place a diver's deposit hold.

    A checkout the buyer never authorized is replaced: PayPal may still show its order
    as approved, but only our authorize call places a hold, and that call now finds the
    attempt closed. An attempt already sent to PayPal blocks until it settles.
    """
    diver = connection.execute(
        "SELECT d.state,b.deposit_minor FROM deposit_divers d JOIN deposit_bookings b "
        "ON b.id=d.booking_id WHERE d.id=%s AND d.booking_id=%s FOR UPDATE OF d",
        (diver_id, booking_id),
    ).fetchone()
    if diver is None:
        raise DomainError("NOT_FOUND")
    if diver["state"] != "pending":
        raise DepositConflict("DEPOSIT_ALREADY_HELD")
    for replaced in connection.execute(
        "UPDATE deposit_money_commands SET status='rejected',"
        "error_code='CHECKOUT_REPLACED',completed_at=clock_timestamp() "
        "WHERE diver_id=%s AND kind='authorize' AND method='checkout' "
        "AND status='pending' AND sent_at IS NULL RETURNING id",
        (diver_id,),
    ).fetchall():
        append(
            connection,
            booking_id,
            "payment_authorize_rejected",
            {
                "diverId": diver_id,
                "commandId": str(replaced["id"]),
                "amountMinor": diver["deposit_minor"],
                "errorCode": "CHECKOUT_REPLACED",
            },
        )
    if connection.execute(
        "SELECT 1 FROM deposit_money_commands WHERE diver_id=%s AND kind='authorize' "
        "AND status IN ('pending','unknown')",
        (diver_id,),
    ).fetchone():
        raise DepositConflict("DEPOSIT_HOLD_IN_FLIGHT")
    return record_command(
        connection,
        booking_id=booking_id,
        diver_id=diver_id,
        kind="authorize",
        amount_minor=diver["deposit_minor"],
        method=method,
        command_id=command_id,
        order_id=order_id,
    )


def deposit_of(connection: ConnectionType, booking_id: str, diver_id: str) -> int:
    row = connection.execute(
        "SELECT b.deposit_minor FROM deposit_divers d JOIN deposit_bookings b "
        "ON b.id=d.booking_id WHERE d.id=%s AND d.booking_id=%s",
        (diver_id, booking_id),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return int(row["deposit_minor"])


def request_id(kind: CommandKind, command_id: str) -> str:
    return f"dive-{kind}-{command_id}"


def invoice_id(command_id: str) -> str:
    return f"dive-{command_id}"


def checkout_attempt(
    connection: ConnectionType, booking_id: str, diver_id: str, order_id: str
) -> str:
    row = connection.execute(
        "SELECT id FROM deposit_money_commands WHERE booking_id=%s AND diver_id=%s "
        "AND kind='authorize' AND method='checkout' AND order_id=%s "
        "AND status IN ('pending','unknown')",
        (booking_id, diver_id, order_id),
    ).fetchone()
    if row is None:
        raise DepositConflict("DEPOSIT_ATTEMPT_CLOSED")
    return str(row["id"])


def claim_command(connection: ConnectionType, command_id: str) -> dict[str, Any]:
    """Mark an open command as sent, so no newer attempt can replace it."""
    row = connection.execute(
        "UPDATE deposit_money_commands SET sent_at=COALESCE(sent_at,clock_timestamp()) "
        "WHERE id=%s AND status IN ('pending','unknown') RETURNING *",
        (command_id,),
    ).fetchone()
    if row is None:
        raise DepositConflict("MONEY_COMMAND_NOT_OPEN")
    return row


def divers(connection: ConnectionType, booking_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT * FROM deposit_divers WHERE booking_id=%s ORDER BY created_at,id",
        (booking_id,),
    ).fetchall()


def payments(connection: ConnectionType, booking_id: str) -> list[DiverPayment]:
    return [
        DiverPayment(
            diverId=str(row["id"]),
            state=row["state"],
            authorizedMinor=row["authorized_minor"],
            capturedMinor=row["captured_minor"],
            refundedMinor=row["refunded_minor"],
        )
        for row in divers(connection, booking_id)
        if row["state"] != "pending"
    ]


def record_command(
    connection: ConnectionType,
    *,
    booking_id: str,
    diver_id: str,
    kind: CommandKind,
    amount_minor: int,
    final_capture: bool = False,
    settlement_id: str | None = None,
    method: PaymentMethod | None = None,
    command_id: str | None = None,
    order_id: str | None = None,
) -> dict[str, Any]:
    command_id = command_id or str(uuid4())
    row = connection.execute(
        "INSERT INTO deposit_money_commands(id,booking_id,diver_id,settlement_id,kind,"
        "amount_minor,final_capture,request_id,invoice_id,status,method,order_id) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending',%s,%s) RETURNING *",
        (
            command_id,
            booking_id,
            diver_id,
            settlement_id,
            kind,
            amount_minor,
            final_capture,
            request_id(kind, command_id),
            invoice_id(command_id),
            method,
            order_id,
        ),
    ).fetchone()
    assert row is not None
    return row


def open_commands(connection: ConnectionType, booking_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT * FROM deposit_money_commands WHERE booking_id=%s "
        "AND status IN ('pending','unknown') ORDER BY created_at,id",
        (booking_id,),
    ).fetchall()


def complete_command(
    connection: ConnectionType,
    command_id: str,
    status: CommandStatus,
    *,
    result: dict[str, Any] | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    """Settle a command and apply a succeeded outcome to the diver's payment state."""
    row = connection.execute(
        "UPDATE deposit_money_commands SET status=%s,result=%s,error_code=%s,"
        "attempts=attempts+1,completed_at=CASE WHEN %s IN ('succeeded','rejected') "
        "THEN clock_timestamp() END WHERE id=%s AND status IN ('pending','unknown') "
        "RETURNING *",
        (
            status,
            Jsonb(result) if result is not None else None,
            error_code,
            status,
            command_id,
        ),
    ).fetchone()
    if row is None:
        raise DepositConflict("MONEY_COMMAND_NOT_OPEN")
    if status == "succeeded":
        apply_outcome(connection, row, result or {})
    append(
        connection,
        str(row["booking_id"]),
        f"payment_{row['kind']}_{status}",
        {
            "diverId": str(row["diver_id"]),
            "commandId": command_id,
            "amountMinor": row["amount_minor"],
            "errorCode": error_code,
        },
    )
    return row


def apply_outcome(
    connection: ConnectionType, command: dict[str, Any], result: dict[str, Any]
) -> None:
    kind, amount = command["kind"], command["amount_minor"]
    update: tuple[str, tuple[Any, ...]]
    if kind == "authorize":
        update = (
            "state='authorized',authorization_id=%s,"
            "authorization_expires_at=%s,authorized_minor=%s",
            (
                result["authorizationId"],
                result.get("expiresAt"),
                amount,
            ),
        )
    elif kind == "capture":
        update = (
            "state='captured',capture_id=%s,captured_minor=%s",
            (result["captureId"], amount),
        )
    elif kind == "void":
        update = ("state='voided'", ())
    else:
        update = ("refunded_minor=refunded_minor+%s", (amount,))
    connection.execute(
        f"UPDATE deposit_divers SET {update[0]} WHERE id=%s",  # noqa: S608
        (*update[1], command["diver_id"]),
    )


def save_settlement(
    connection: ConnectionType,
    booking_id: str,
    *,
    source: Literal["ai", "no_ai", "organizer"],
    facts: SettlementFacts,
    plan: list[DiverSettlement],
    check: MandateCheck,
    agent_call_id: str | None = None,
) -> str:
    settlement_id = str(uuid4())
    connection.execute(
        "INSERT INTO deposit_settlements(id,booking_id,source,facts,plan,"
        "within_mandate,reasons,status,agent_call_id) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,'proposed',%s)",
        (
            settlement_id,
            booking_id,
            source,
            Jsonb(facts.model_dump(mode="json")),
            Jsonb([item.model_dump(mode="json") for item in plan]),
            check.withinMandate,
            Jsonb(check.reasons),
            agent_call_id,
        ),
    )
    append(
        connection,
        booking_id,
        "settlement_proposed",
        {
            "settlementId": settlement_id,
            "source": source,
            "cause": facts.cause,
            "cancelledDays": facts.cancelledDays,
            "evidenceIds": facts.evidenceIds,
            "withinMandate": check.withinMandate,
            "reasons": check.reasons,
        },
    )
    return settlement_id


def decide_settlement(
    connection: ConnectionType,
    booking_id: str,
    settlement_id: str,
    decision: Literal["approved", "rejected", "executed"],
    actor: Literal["organizer", "agent"],
) -> dict[str, Any]:
    allowed = ("proposed", "approved") if decision == "executed" else ("proposed",)
    row = connection.execute(
        "UPDATE deposit_settlements SET status=%s,decided_at=COALESCE(decided_at,"
        "clock_timestamp()) WHERE id=%s AND booking_id=%s AND status = ANY(%s) "
        "RETURNING *",
        (decision, settlement_id, booking_id, list(allowed)),
    ).fetchone()
    if row is None:
        raise DepositConflict("SETTLEMENT_NOT_OPEN")
    append(
        connection,
        booking_id,
        f"settlement_{decision}",
        {"settlementId": settlement_id, "actor": actor},
    )
    return row


def timeline(connection: ConnectionType, booking_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT kind,detail,created_at FROM deposit_timeline WHERE booking_id=%s "
        "ORDER BY id",
        (booking_id,),
    ).fetchall()


def add_evidence(
    connection: ConnectionType,
    booking_id: str,
    kind: Literal["notice", "alert", "forecast", "simulated"],
    body: str,
    data: dict[str, Any] | None = None,
) -> str:
    evidence_id = str(uuid4())
    connection.execute(
        "INSERT INTO deposit_evidence(id,booking_id,kind,body,data) "
        "VALUES(%s,%s,%s,%s,%s)",
        (evidence_id, booking_id, kind, body, Jsonb(data) if data else None),
    )
    append(
        connection,
        booking_id,
        "evidence_added",
        {"evidenceId": evidence_id, "kind": kind, "excerpt": body[:200]},
    )
    return evidence_id


def evidence(connection: ConnectionType, booking_id: str) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT id,kind,body,data,created_at FROM deposit_evidence "
        "WHERE booking_id=%s ORDER BY created_at,id",
        (booking_id,),
    ).fetchall()


def settlements(connection: ConnectionType, booking_id: str) -> list[dict[str, Any]]:
    """Settlements with the agent call behind them; a replay shows its original time."""
    return connection.execute(
        "SELECT s.*,c.mode AS agent_mode,c.status AS agent_status,"
        "c.model AS agent_model,c.result AS agent_result,"
        "COALESCE(o.created_at,c.created_at) AS agent_at "
        "FROM deposit_settlements s "
        "LEFT JOIN deposit_agent_calls c ON c.id=s.agent_call_id "
        "LEFT JOIN deposit_agent_calls o ON o.id=c.replay_of "
        "WHERE s.booking_id=%s ORDER BY s.created_at,s.id",
        (booking_id,),
    ).fetchall()


AGENT_CALL_LOCK = 724914


def reserve_agent_call(
    connection: ConnectionType,
    booking_id: str,
    *,
    digest: str,
    daily_cap: int,
    today: date,
) -> dict[str, Any]:
    """Start a live call under the daily cap, else replay a recorded result or refuse.

    Every started live call counts, even one that later fails or never finishes.
    """
    connection.execute("SELECT pg_advisory_xact_lock(%s,0)", (AGENT_CALL_LOCK,))
    used = connection.execute(
        "SELECT count(*) AS n FROM deposit_agent_calls WHERE day=%s AND mode='live'",
        (today,),
    ).fetchone()
    call_id = str(uuid4())
    if used is not None and used["n"] < daily_cap:
        row = connection.execute(
            "INSERT INTO deposit_agent_calls(id,booking_id,day,mode,status,"
            "input_digest) VALUES(%s,%s,%s,'live','started',%s) RETURNING *",
            (call_id, booking_id, today, digest),
        ).fetchone()
    else:
        row = (
            replay_agent_call(connection, booking_id, digest=digest, today=today)
            or connection.execute(
                "INSERT INTO deposit_agent_calls(id,booking_id,day,mode,status,"
                "input_digest,error_code,finished_at) VALUES(%s,%s,%s,'capped',"
                "'failed',%s,'DAILY_CAP_REACHED',clock_timestamp()) RETURNING *",
                (call_id, booking_id, today, digest),
            ).fetchone()
        )
    if row is None:
        raise DomainError("AGENT_CALL_NOT_RECORDED")
    return row


def replay_agent_call(
    connection: ConnectionType, booking_id: str, *, digest: str, today: date
) -> dict[str, Any] | None:
    """Record a replay of the latest successful live result for identical input."""
    return connection.execute(
        "INSERT INTO deposit_agent_calls(id,booking_id,day,mode,status,input_digest,"
        "model,replay_of,result,finished_at) SELECT %s,%s,%s,'recorded','succeeded',"
        "input_digest,model,id,result,clock_timestamp() FROM deposit_agent_calls "
        "WHERE mode='live' AND status='succeeded' AND input_digest=%s "
        "ORDER BY created_at DESC LIMIT 1 RETURNING *",
        (str(uuid4()), booking_id, today, digest),
    ).fetchone()


def finish_agent_call(
    connection: ConnectionType,
    call_id: str,
    *,
    model: str | None,
    result: dict[str, Any] | None,
    error_code: str | None,
) -> None:
    row = connection.execute(
        "UPDATE deposit_agent_calls SET status=%s,model=%s,result=%s,error_code=%s,"
        "finished_at=clock_timestamp() WHERE id=%s AND status='started' RETURNING id",
        (
            "failed" if error_code else "succeeded",
            model,
            Jsonb(result) if result is not None else None,
            error_code,
            call_id,
        ),
    ).fetchone()
    if row is None:
        raise DomainError("AGENT_CALL_NOT_STARTED")


def workspace_bookings(connection: ConnectionType, workspace: str) -> list[str]:
    rows = connection.execute(
        "SELECT id FROM deposit_bookings WHERE workspace_hash=%s ORDER BY created_at",
        (workspace_hash(workspace),),
    ).fetchall()
    return [str(row["id"]) for row in rows]
