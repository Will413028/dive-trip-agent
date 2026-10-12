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

ConnectionType = Connection[dict[str, Any]]
CommandKind = Literal["authorize", "capture", "void", "refund"]
CommandStatus = Literal["succeeded", "rejected", "unknown"]


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


def add_diver(
    connection: ConnectionType, booking_id: str, name: str, *, seeded: bool
) -> str:
    diver_id = str(uuid4())
    connection.execute(
        "INSERT INTO deposit_divers(id,booking_id,display_name,seeded,state) "
        "VALUES(%s,%s,%s,%s,'pending')",
        (diver_id, booking_id, name, seeded),
    )
    append(connection, booking_id, "diver_joined", {"diverId": diver_id, "name": name})
    return diver_id


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
) -> dict[str, Any]:
    command_id = str(uuid4())
    row = connection.execute(
        "INSERT INTO deposit_money_commands(id,booking_id,diver_id,settlement_id,kind,"
        "amount_minor,final_capture,request_id,invoice_id,status) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending') RETURNING *",
        (
            command_id,
            booking_id,
            diver_id,
            settlement_id,
            kind,
            amount_minor,
            final_capture,
            f"dive-{kind}-{command_id}",
            f"dive-{command_id}",
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
        raise DomainError("MONEY_COMMAND_NOT_OPEN")
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
            "state='authorized',order_id=%s,authorization_id=%s,"
            "authorization_expires_at=%s,authorized_minor=%s",
            (
                result["orderId"],
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
) -> str:
    settlement_id = str(uuid4())
    connection.execute(
        "INSERT INTO deposit_settlements(id,booking_id,source,facts,plan,"
        "within_mandate,reasons,status) VALUES(%s,%s,%s,%s,%s,%s,%s,'proposed')",
        (
            settlement_id,
            booking_id,
            source,
            Jsonb(facts.model_dump(mode="json")),
            Jsonb([item.model_dump(mode="json") for item in plan]),
            check.withinMandate,
            Jsonb(check.reasons),
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
        raise DomainError("SETTLEMENT_NOT_OPEN")
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
