"""Money command execution: store, call PayPal outside the transaction, then settle.

A command is committed as `pending` before PayPal is called. Rejections close it; an
unknown outcome leaves it open, and `reconcile` retries it with the same request id so
PayPal returns the original result instead of moving money again.
"""

from typing import Any

from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError

from . import transactions as tx
from .domain import DiverSettlement
from .paypal import PayPalClient, PayPalError, PayPalUnknownOutcome, SandboxCard

KIND_OF_ACTION = {
    "void": "void",
    "partial_capture": "capture",
    "capture": "capture",
    "refund": "refund",
}


async def send(
    client: PayPalClient,
    command: dict[str, Any],
    diver: dict[str, Any],
    card: SandboxCard | None,
) -> dict[str, Any]:
    kind, request_id = command["kind"], command["request_id"]
    if kind == "authorize":
        if card is not None:
            auth = await client.create_card_authorization(
                invoice_id=command["invoice_id"],
                amount_minor=command["amount_minor"],
                card=card,
                request_id=request_id,
            )
        elif diver["order_id"]:  # the buyer's own checkout order
            auth = await client.authorize_order(
                diver["order_id"], request_id=request_id
            )
        else:
            raise DomainError("DEPOSIT_CARD_REQUIRED")
        if auth.status != "CREATED" or auth.amountMinor != command["amount_minor"]:
            raise DomainError("PAYPAL_AUTHORIZATION_UNEXPECTED")
        return {
            "orderId": auth.orderId,
            "authorizationId": auth.authorizationId,
            "expiresAt": auth.expiresAt,
        }
    if kind == "capture":
        capture = await client.capture(
            diver["authorization_id"],
            amount_minor=command["amount_minor"],
            final=command["final_capture"],
            invoice_id=command["invoice_id"],
            request_id=request_id,
        )
        return {"captureId": capture.captureId, "status": capture.status}
    if kind == "void":
        await client.void(diver["authorization_id"], request_id=request_id)
        return {}
    refund = await client.refund(
        diver["capture_id"],
        amount_minor=command["amount_minor"],
        invoice_id=command["invoice_id"],
        request_id=request_id,
    )
    return {"refundId": refund.refundId, "status": refund.status}


async def execute(
    database: Database,
    client: PayPalClient,
    command_id: str,
    card: SandboxCard | None = None,
) -> str:
    with database.transaction() as connection:
        command = connection.execute(
            "SELECT * FROM deposit_money_commands WHERE id=%s "
            "AND status IN ('pending','unknown')",
            (command_id,),
        ).fetchone()
        if command is None:
            raise DomainError("MONEY_COMMAND_NOT_OPEN")
        diver = connection.execute(
            "SELECT * FROM deposit_divers WHERE id=%s", (command["diver_id"],)
        ).fetchone()
        assert diver is not None
    try:
        result = await send(client, command, diver, card)
    except PayPalUnknownOutcome:
        with database.transaction() as connection:
            tx.complete_command(connection, command_id, "unknown")
        return "unknown"
    except PayPalError as error:
        with database.transaction() as connection:
            tx.complete_command(
                connection, command_id, "rejected", error_code=error.code
            )
        return "rejected"
    with database.transaction() as connection:
        tx.complete_command(connection, command_id, "succeeded", result=result)
    return "succeeded"


async def reconcile(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    card: SandboxCard | None = None,
) -> dict[str, str]:
    """Retry every open command with its original request id."""
    with database.transaction() as connection:
        open_ids = [str(c["id"]) for c in tx.open_commands(connection, booking_id)]
    return {
        command_id: await execute(database, client, command_id, card)
        for command_id in open_ids
    }


async def authorize_diver(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    name: str,
    card: SandboxCard,
    *,
    seeded: bool,
) -> tuple[str, str]:
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT deposit_minor FROM deposit_bookings WHERE id=%s", (booking_id,)
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
        diver_id = tx.add_diver(connection, booking_id, name, seeded=seeded)
        command = tx.record_command(
            connection,
            booking_id=booking_id,
            diver_id=diver_id,
            kind="authorize",
            amount_minor=row["deposit_minor"],
        )
    return diver_id, await execute(database, client, str(command["id"]), card)


async def start_checkout(
    database: Database, client: PayPalClient, booking_id: str, name: str
) -> tuple[str, str]:
    """Add a diver whose deposit hold the buyer approves in PayPal's checkout.

    The authorize command is stored first; `complete_checkout` (or a reconcile)
    sends it once PayPal reports the order approved.
    """
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT deposit_minor FROM deposit_bookings WHERE id=%s", (booking_id,)
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
        # A declined checkout leaves the diver without a hold; retrying reuses it.
        diver_id = tx.retry_checkout_diver(connection, booking_id, name) or (
            tx.add_diver(connection, booking_id, name, seeded=False)
        )
        command = tx.record_command(
            connection,
            booking_id=booking_id,
            diver_id=diver_id,
            kind="authorize",
            amount_minor=row["deposit_minor"],
        )
    try:
        order_id = await client.create_checkout_order(
            invoice_id=command["invoice_id"],
            amount_minor=command["amount_minor"],
            request_id=f"{command['request_id']}-order",
        )
    except DomainError as error:
        # No order means nothing the buyer could approve: close the hold attempt.
        with database.transaction() as connection:
            tx.complete_command(
                connection, str(command["id"]), "rejected", error_code=error.code
            )
        raise
    with database.transaction() as connection:
        tx.set_checkout_order(connection, diver_id, order_id)
    return diver_id, order_id


async def complete_checkout(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    diver_id: str,
    order_id: str,
) -> str:
    with database.transaction() as connection:
        command = connection.execute(
            "SELECT c.id FROM deposit_money_commands c JOIN deposit_divers d "
            "ON d.id=c.diver_id WHERE c.booking_id=%s AND c.diver_id=%s "
            "AND c.kind='authorize' AND c.status IN ('pending','unknown') "
            "AND d.order_id=%s",
            (booking_id, diver_id, order_id),
        ).fetchone()
        if command is None:
            raise DomainError("MONEY_COMMAND_NOT_OPEN")
    outcome = await execute(database, client, str(command["id"]))
    if outcome == "unknown":  # a reconcile retries it with the same request id
        raise PayPalUnknownOutcome()
    if outcome == "rejected":
        with database.transaction() as connection:
            closed = connection.execute(
                "SELECT error_code FROM deposit_money_commands WHERE id=%s",
                (command["id"],),
            ).fetchone()
        raise DomainError((closed or {}).get("error_code") or "PAYPAL_REJECTED")
    return outcome


async def execute_settlement(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    settlement_id: str,
    actor: str,
) -> dict[str, str]:
    with database.transaction() as connection:
        settlement = connection.execute(
            "SELECT * FROM deposit_settlements WHERE id=%s AND booking_id=%s "
            "AND status IN ('proposed','approved')",
            (settlement_id, booking_id),
        ).fetchone()
        if settlement is None:
            raise DomainError("SETTLEMENT_NOT_OPEN")
        if settlement["status"] == "proposed":
            if actor != "agent" or not settlement["within_mandate"]:
                raise DomainError("SETTLEMENT_NEEDS_APPROVAL")
        plan = [DiverSettlement.model_validate(item) for item in settlement["plan"]]
        command_ids = []
        for item in plan:
            if item.action == "none":
                continue
            command = tx.record_command(
                connection,
                booking_id=booking_id,
                diver_id=item.diverId,
                kind=KIND_OF_ACTION[item.action],  # type: ignore[arg-type]
                amount_minor=item.amountMinor,
                final_capture=item.action in ("partial_capture", "capture"),
                settlement_id=settlement_id,
            )
            command_ids.append(str(command["id"]))
    outcomes = {
        command_id: await execute(database, client, command_id)
        for command_id in command_ids
    }
    if all(outcome == "succeeded" for outcome in outcomes.values()):
        with database.transaction() as connection:
            tx.decide_settlement(
                connection,
                booking_id,
                settlement_id,
                "executed",
                "agent" if actor == "agent" else "organizer",
            )
    return outcomes


async def void_all_holds(database: Database, client: PayPalClient) -> dict[str, str]:
    """Release every open hold in the schema, e.g. before a demo rebuild."""
    with database.transaction() as connection:
        held = connection.execute(
            "SELECT id,booking_id FROM deposit_divers WHERE state='authorized'"
        ).fetchall()
        command_ids = [
            str(
                tx.record_command(
                    connection,
                    booking_id=str(row["booking_id"]),
                    diver_id=str(row["id"]),
                    kind="void",
                    amount_minor=0,
                )["id"]
            )
            for row in held
        ]
    return {
        command_id: await execute(database, client, command_id)
        for command_id in command_ids
    }
