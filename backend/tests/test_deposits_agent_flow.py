"""Assessment with the settlement agent: guard, daily cap, recorded results, No AI."""

from datetime import date

import httpx2 as httpx
import pytest
from test_deposits_agent import NOTICE, reader
from test_deposits_service import CARD, POLICY
from test_deposits_workflow import MANDATE, AlwaysCaptures

from dive_trip.application import deposits as app
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.assessor import (
    AgentAssessment,
    AgentInput,
    SettlementAgent,
)
from dive_trip.modules.deposits.paypal import PayPalClient

pytestmark = pytest.mark.integration


@pytest.fixture
async def paypal():
    client = PayPalClient(
        "id", "s", transport=httpx.MockTransport(AlwaysCaptures().handle)
    )
    yield client
    await client.aclose()


async def booking(ctx: app.DepositsContext, *, storm: bool = True) -> str:
    booking_id = await app.create_booking(
        ctx,
        workspace="judge",
        title="Boat dives",
        starts_on=date(2026, 11, 20),
        site=(22.33, 120.37),
        policy=POLICY,
        mandate=MANDATE,
        seed_divers=1,
    )
    with ctx.database.transaction() as connection:
        tx.add_evidence(connection, booking_id, "notice", NOTICE)
        if storm:
            tx.add_evidence(
                connection,
                booking_id,
                "simulated",
                "SIMULATED storm for the demo: boats cancelled on day(s) 2",
                {"cancelledDays": [2]},
            )
    return booking_id


def settlement(ctx: app.DepositsContext, booking_id: str) -> dict:
    with ctx.database.transaction() as connection:
        [row] = tx.settlements(connection, booking_id)
        return row


def calls(ctx: app.DepositsContext) -> list[dict]:
    with ctx.database.transaction() as connection:
        return connection.execute(
            "SELECT * FROM deposit_agent_calls ORDER BY created_at"
        ).fetchall()


async def test_agent_reading_that_agrees_with_rules_executes_within_mandate(
    database, paypal
):
    ctx = app.DepositsContext(
        database, paypal, CARD, assessor=SettlementAgent(reader(days=[2]))
    )
    booking_id = await booking(ctx)
    result = await app.assess(ctx, booking_id)
    row = settlement(ctx, booking_id)
    assert (row["source"], row["status"], row["reasons"]) == ("ai", "executed", [])
    assert list(result["executed"].values()) == ["succeeded"]
    assert (row["agent_mode"], row["agent_status"]) == ("live", "succeeded")
    assert row["agent_result"]["citations"][0]["quote"] == (
        "all boats are cancelled on Day 2"
    )
    with database.transaction() as connection:
        [diver] = tx.divers(connection, booking_id)
    assert (diver["state"], diver["captured_minor"]) == ("captured", 6667)


async def test_notice_the_rules_cannot_read_waits_for_the_organizer(database, paypal):
    ctx = app.DepositsContext(
        database, paypal, CARD, assessor=SettlementAgent(reader(days=[2]))
    )
    booking_id = await booking(ctx, storm=False)
    await app.assess(ctx, booking_id)
    row = settlement(ctx, booking_id)
    assert (row["source"], row["status"]) == ("ai", "proposed")
    assert row["reasons"] == ["AI_AND_RULES_DISAGREE"]


async def test_agent_that_asks_for_review_never_auto_executes(database, paypal):
    ctx = app.DepositsContext(
        database,
        paypal,
        CARD,
        assessor=SettlementAgent(reader(days=[2], confidence="medium", execute=False)),
    )
    booking_id = await booking(ctx)
    await app.assess(ctx, booking_id)
    row = settlement(ctx, booking_id)
    assert row["status"] == "proposed"
    assert row["reasons"] == ["AI_NOT_CONFIDENT", "AI_REQUESTED_REVIEW"]


async def test_model_failure_falls_back_to_no_ai(database, paypal):
    async def broken(snapshot: AgentInput) -> AgentAssessment:
        raise TimeoutError

    ctx = app.DepositsContext(database, paypal, CARD, assessor=broken)
    booking_id = await booking(ctx)
    await app.assess(ctx, booking_id)
    row = settlement(ctx, booking_id)
    assert (row["source"], row["status"]) == ("no_ai", "proposed")
    assert row["reasons"] == ["NO_AI_NEEDS_APPROVAL", "AI_UNAVAILABLE"]
    [call] = calls(ctx)
    assert (call["mode"], call["status"], call["error_code"]) == (
        "live",
        "failed",
        "TimeoutError",
    )


async def test_daily_cap_replays_recorded_results_then_stops_live_calls(
    database, paypal
):
    runs = 0

    async def counted(snapshot: AgentInput) -> AgentAssessment:
        nonlocal runs
        runs += 1
        return await SettlementAgent(reader(days=[2]))(snapshot)

    ctx = app.DepositsContext(
        database, paypal, CARD, assessor=counted, daily_live_cap=1
    )
    first = await booking(ctx)
    await app.assess(ctx, first)

    # Reset deletes the booking; its live call still counts against today's cap.
    with database.transaction() as connection:
        connection.execute("DELETE FROM deposit_bookings WHERE id=%s", (first,))

    same = await booking(ctx)
    await app.assess(ctx, same)
    replay = settlement(ctx, same)
    with database.transaction() as connection:
        notice_id = next(
            str(e["id"]) for e in tx.evidence(connection, same) if e["kind"] == "notice"
        )
    assert replay["agent_mode"] == "recorded"
    assert replay["agent_model"] == "scripted-reader"
    assert replay["facts"]["evidenceIds"] == [notice_id]
    assert replay["status"] == "executed"

    different = await booking(ctx)
    with database.transaction() as connection:
        tx.add_evidence(connection, different, "alert", "Small craft advisory")
    await app.assess(ctx, different)
    capped = settlement(ctx, different)
    assert capped["source"] == "no_ai"
    assert capped["agent_mode"] == "capped"
    assert capped["reasons"] == ["NO_AI_NEEDS_APPROVAL", "AI_DAILY_CAP_REACHED"]

    assert runs == 1
    modes = [(c["mode"], c["booking_id"] is None) for c in calls(ctx)]
    assert modes == [("live", True), ("recorded", False), ("capped", False)]
