from datetime import date

import psycopg
import pytest

from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.domain import (
    CauseRule,
    Mandate,
    RefundPolicy,
    SettlementFacts,
    check_mandate,
    settle,
)
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration

POLICY = RefundPolicy(
    version=1,
    currency="USD",
    depositMinor=10000,
    tripDays=3,
    rules=[CauseRule(cause="weather", refundPercent=100)],
)
MANDATE = Mandate(
    autoMaxPerDiverMinor=5000,
    autoMaxPerBookingMinor=20000,
    allowedActions=["void", "partial_capture", "capture", "refund"],
    allowedCauses=["weather"],
    expiresOn="2026-12-31",
)


def new_booking(connection: tx.ConnectionType, workspace: str = "judge-1") -> str:
    return tx.create_booking(
        connection,
        workspace=workspace,
        title="Two-tank boat dives",
        starts_on=date(2026, 11, 20),
        site=(22.33, 120.37),
        policy=POLICY,
        mandate=MANDATE,
    )


def authorize(connection: tx.ConnectionType, booking_id: str, name: str) -> str:
    diver = tx.add_diver(connection, booking_id, name, seeded=True)
    command = tx.record_command(
        connection,
        booking_id=booking_id,
        diver_id=diver,
        kind="authorize",
        amount_minor=10000,
    )
    tx.complete_command(
        connection,
        str(command["id"]),
        "succeeded",
        result={"orderId": f"O-{name}", "authorizationId": f"A-{name}"},
    )
    return diver


def test_partial_cancellation_flows_from_hold_to_final_capture(database) -> None:
    with database.transaction() as connection:
        booking_id = new_booking(connection)
        authorize(connection, booking_id, "Ana")
        authorize(connection, booking_id, "Ben")
        facts = SettlementFacts(
            cause="weather", cancelledDays=[2], evidenceIds=["notice-1"]
        )
        plan = settle(POLICY, facts, tx.payments(connection, booking_id))
        check = check_mandate(MANDATE, facts, plan, "2026-11-21")
        assert check.withinMandate
        settlement = tx.save_settlement(
            connection, booking_id, source="ai", facts=facts, plan=plan, check=check
        )
        for item in plan:
            command = tx.record_command(
                connection,
                booking_id=booking_id,
                diver_id=item.diverId,
                kind="capture",
                amount_minor=item.amountMinor,
                final_capture=True,
                settlement_id=settlement,
            )
            tx.complete_command(
                connection, str(command["id"]), "succeeded", result={"captureId": "C"}
            )
        tx.decide_settlement(connection, booking_id, settlement, "executed", "agent")
        states = {
            row["display_name"]: (row["state"], row["captured_minor"])
            for row in tx.divers(connection, booking_id)
        }
        assert states == {"Ana": ("captured", 6667), "Ben": ("captured", 6667)}
        kinds = [row["kind"] for row in tx.timeline(connection, booking_id)]
        assert kinds[0] == "booking_created"
        assert kinds[-1] == "settlement_executed"
        assert kinds.count("payment_capture_succeeded") == 2


def test_a_second_live_command_of_the_same_kind_is_refused(database) -> None:
    with database.transaction() as connection:
        booking_id = new_booking(connection)
        diver = authorize(connection, booking_id, "Ana")
        tx.record_command(
            connection,
            booking_id=booking_id,
            diver_id=diver,
            kind="void",
            amount_minor=0,
        )
    with pytest.raises(psycopg.errors.UniqueViolation):
        with database.transaction() as connection:
            tx.record_command(
                connection,
                booking_id=booking_id,
                diver_id=diver,
                kind="void",
                amount_minor=0,
            )


def test_unknown_outcome_stays_open_and_completes_once(database) -> None:
    with database.transaction() as connection:
        booking_id = new_booking(connection)
        diver = authorize(connection, booking_id, "Ana")
        command = tx.record_command(
            connection,
            booking_id=booking_id,
            diver_id=diver,
            kind="void",
            amount_minor=0,
        )
        tx.complete_command(connection, str(command["id"]), "unknown")
        assert [str(c["id"]) for c in tx.open_commands(connection, booking_id)] == [
            str(command["id"])
        ]
        tx.complete_command(connection, str(command["id"]), "succeeded", result={})
        assert tx.open_commands(connection, booking_id) == []
        with pytest.raises(DomainError, match="MONEY_COMMAND_NOT_OPEN"):
            tx.complete_command(connection, str(command["id"]), "succeeded", result={})


def test_workspaces_are_isolated_and_policy_is_immutable(database) -> None:
    with database.transaction() as connection:
        booking_id = new_booking(connection, "judge-1")
        with pytest.raises(DomainError, match="NOT_FOUND"):
            tx.booking(connection, "judge-2", booking_id)
    with pytest.raises(psycopg.errors.RaiseException, match="IMMUTABLE"):
        with database.transaction() as connection:
            connection.execute(
                "UPDATE deposit_bookings SET deposit_minor=1 WHERE id=%s", (booking_id,)
            )
    with pytest.raises(psycopg.errors.RaiseException, match="APPEND_ONLY"):
        with database.transaction() as connection:
            connection.execute(
                "UPDATE deposit_timeline SET kind='edited' WHERE booking_id=%s",
                (booking_id,),
            )
