"""Money command execution: store, call PayPal outside the transaction, then settle.

A command is committed as `pending` before PayPal is called. Rejections close it; an
unknown outcome leaves it open, and `reconcile` retries it with the same request id so
PayPal returns the original result instead of moving money again.
"""

from typing import Any
from uuid import uuid4

from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError

from . import transactions as tx
from .domain import DiverSettlement
from .errors import DepositConflict
from .paypal import (
    PayPalClient,
    PayPalError,
    PayPalUnexpectedResponse,
    PayPalUnknownOutcome,
    SandboxCard,
)

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
        if command["method"] == "checkout":  # the buyer's own approved order
            auth = await client.authorize_order(
                command["order_id"], request_id=request_id
            )
        elif card is not None:
            auth = await client.create_card_authorization(
                invoice_id=command["invoice_id"],
                amount_minor=command["amount_minor"],
                card=card,
                request_id=request_id,
            )
        else:
            raise DomainError("DEPOSIT_CARD_REQUIRED")
        if auth.status != "CREATED" or auth.amountMinor != command["amount_minor"]:
            raise PayPalUnexpectedResponse("PAYPAL_AUTHORIZATION_UNEXPECTED")
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
        command = tx.claim_command(connection, command_id)
        if command["method"] == "test_card" and card is None:
            raise DomainError("DEPOSIT_CARD_REQUIRED")  # rolls the claim back
        diver = connection.execute(
            "SELECT * FROM deposit_divers WHERE id=%s", (command["diver_id"],)
        ).fetchone()
        assert diver is not None
    try:
        result = await send(client, command, diver, card)
    except PayPalUnknownOutcome as error:
        with database.transaction() as connection:
            tx.complete_command(
                connection, command_id, "unknown", error_code=error.code
            )
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
    """Retry every open command with its original request id.

    One command that cannot be sent does not stop the others; its code is the outcome.
    """
    with database.transaction() as connection:
        open_ids = [str(c["id"]) for c in tx.open_commands(connection, booking_id)]
    outcomes: dict[str, str] = {}
    for command_id in open_ids:
        try:
            outcomes[command_id] = await execute(database, client, command_id, card)
        except DomainError as error:
            outcomes[command_id] = error.code
    return outcomes


class HoldRejected(DepositConflict):
    """The attempt closed without a hold; the code says why (decline, replaced)."""


def _held(database: Database, command_id: str, outcome: str) -> None:
    """Raise unless the attempt placed the hold, with the reason PayPal gave."""
    if outcome == "unknown":  # a reconcile retries it with the same request id
        raise PayPalUnknownOutcome()
    if outcome == "rejected":
        with database.transaction() as connection:
            closed = connection.execute(
                "SELECT error_code FROM deposit_money_commands WHERE id=%s",
                (command_id,),
            ).fetchone()
        raise HoldRejected((closed or {}).get("error_code") or "PAYPAL_REJECTED")


async def hold_with_test_card(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    diver_id: str,
    card: SandboxCard,
) -> None:
    """Place the diver's deposit hold with the server's sandbox test card."""
    with database.transaction() as connection:
        command = tx.open_hold_attempt(connection, booking_id, diver_id, "test_card")
    command_id = str(command["id"])
    _held(database, command_id, await execute(database, client, command_id, card))


async def start_checkout(
    database: Database, client: PayPalClient, booking_id: str, diver_id: str
) -> str:
    """Create the order the buyer approves in PayPal's checkout; return its id.

    An AUTHORIZE order moves no money (only our authorize call places a hold), so it
    is created first and stored with its attempt in one step. An order whose attempt
    is refused or replaced is never authorized and simply expires at PayPal.
    `complete_checkout` (or a reconcile) authorizes it once the buyer approves.
    """
    command_id = str(uuid4())
    with database.transaction() as connection:
        amount_minor = tx.deposit_of(connection, booking_id, diver_id)
    order_id = await client.create_checkout_order(
        invoice_id=tx.invoice_id(command_id),
        amount_minor=amount_minor,
        request_id=f"{tx.request_id('authorize', command_id)}-order",
    )
    with database.transaction() as connection:
        tx.open_hold_attempt(
            connection,
            booking_id,
            diver_id,
            "checkout",
            command_id=command_id,
            order_id=order_id,
        )
    return order_id


async def complete_checkout(
    database: Database,
    client: PayPalClient,
    booking_id: str,
    diver_id: str,
    order_id: str,
) -> None:
    with database.transaction() as connection:
        command_id = tx.checkout_attempt(connection, booking_id, diver_id, order_id)
    try:
        outcome = await execute(database, client, command_id)
    except DepositConflict as error:
        if error.code != "MONEY_COMMAND_NOT_OPEN":
            raise
        # Closed meanwhile: by a reconcile that placed this hold, or a newer attempt.
        with database.transaction() as connection:
            closed = connection.execute(
                "SELECT status FROM deposit_money_commands WHERE id=%s", (command_id,)
            ).fetchone()
        if closed is None or closed["status"] != "succeeded":
            raise DepositConflict("DEPOSIT_ATTEMPT_CLOSED") from error
        outcome = "succeeded"
    _held(database, command_id, outcome)


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
            raise DepositConflict("SETTLEMENT_NOT_OPEN")
        if settlement["status"] == "proposed":
            if actor != "agent" or not settlement["within_mandate"]:
                raise DepositConflict("SETTLEMENT_NEEDS_APPROVAL")
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


async def void_all_holds(
    database: Database, client: PayPalClient, card: SandboxCard
) -> dict[str, str]:
    """Release every open hold in the schema, e.g. before a demo rebuild.

    Open commands are reconciled first, so a hold PayPal placed for an attempt whose
    answer never arrived is recorded, and then released, instead of being lost.
    """
    with database.transaction() as connection:
        booking_ids = [
            str(row["booking_id"])
            for row in connection.execute(
                "SELECT DISTINCT booking_id FROM deposit_money_commands "
                "WHERE status IN ('pending','unknown')"
            ).fetchall()
        ]
    for booking_id in booking_ids:
        await reconcile(database, client, booking_id, card)
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
