import json
import os
from datetime import date
from pathlib import Path

import httpx2 as httpx
import pytest

from dive_trip.modules.deposits import service
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.domain import (
    CauseRule,
    Mandate,
    RefundPolicy,
    SettlementFacts,
    check_mandate,
    settle,
)
from dive_trip.modules.deposits.paypal import PayPalClient, SandboxCard
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration

CARD = SandboxCard("4111111111111111", "2030-12", "123", "Test Diver")
POLICY = RefundPolicy(
    version=1,
    currency="USD",
    depositMinor=10000,
    tripDays=3,
    rules=[CauseRule(cause="weather", refundPercent=100)],
)


def mandate(cap: int) -> Mandate:
    return Mandate(
        autoMaxPerDiverMinor=cap,
        autoMaxPerBookingMinor=cap * 10,
        allowedActions=["void", "partial_capture", "capture", "refund"],
        allowedCauses=["weather"],
        expiresOn="2026-12-31",
    )


class FakePayPal:
    """Records request ids; the first capture attempt times out after taking effect."""

    def __init__(self) -> None:
        self.captures: dict[str, dict[str, object]] = {}
        self.capture_calls = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        body = json.loads(request.content) if request.content else {}
        key = request.headers.get("PayPal-Request-Id", "")
        if path == "/v2/checkout/orders":
            amount = body["purchase_units"][0]["amount"]
            auth = {"id": f"A-{key}", "status": "CREATED", "amount": amount}
            return httpx.Response(
                201,
                json={
                    "id": f"O-{key}",
                    "purchase_units": [{"payments": {"authorizations": [auth]}}],
                },
            )
        if path.endswith("/capture"):
            self.capture_calls += 1
            first = key not in self.captures
            self.captures.setdefault(
                key, {"id": f"C-{key}", "status": "COMPLETED", "amount": body["amount"]}
            )
            if first and self.capture_calls == 1:
                return httpx.Response(504)
            return httpx.Response(201, json=self.captures[key])
        return httpx.Response(404, json={"name": "RESOURCE_NOT_FOUND"})


def booking(connection: tx.ConnectionType, cap: int) -> str:
    return tx.create_booking(
        connection,
        workspace="judge",
        title="Boat dives",
        starts_on=date(2026, 11, 20),
        site=(22.33, 120.37),
        policy=POLICY,
        mandate=mandate(cap),
    )


def propose(connection: tx.ConnectionType, booking_id: str, cap: int) -> str:
    facts = SettlementFacts(cause="weather", cancelledDays=[2], evidenceIds=["n1"])
    plan = settle(POLICY, facts, tx.payments(connection, booking_id))
    check = check_mandate(mandate(cap), facts, plan, "2026-11-21")
    return tx.save_settlement(
        connection, booking_id, source="ai", facts=facts, plan=plan, check=check
    )


async def test_unknown_capture_is_reconciled_with_the_same_request_id(
    database,
) -> None:
    fake = FakePayPal()
    client = PayPalClient("id", "s", transport=httpx.MockTransport(fake.handle))
    with database.transaction() as connection:
        booking_id = booking(connection, cap=5000)
    _, outcome = await service.authorize_diver(
        database, client, booking_id, "Ana", CARD, seeded=True
    )
    assert outcome == "succeeded"
    with database.transaction() as connection:
        settlement_id = propose(connection, booking_id, cap=5000)
    first = await service.execute_settlement(
        database, client, booking_id, settlement_id, "agent"
    )
    assert list(first.values()) == ["unknown"]
    second = await service.reconcile(database, client, booking_id)
    assert list(second.values()) == ["succeeded"]
    assert len(fake.captures) == 1
    with database.transaction() as connection:
        [diver] = tx.divers(connection, booking_id)
        assert (diver["state"], diver["captured_minor"]) == ("captured", 6667)
    await client.aclose()


async def test_settlement_outside_the_mandate_needs_the_organizer(database) -> None:
    fake = FakePayPal()
    client = PayPalClient("id", "s", transport=httpx.MockTransport(fake.handle))
    with database.transaction() as connection:
        booking_id = booking(connection, cap=1000)
    await service.authorize_diver(
        database, client, booking_id, "Ana", CARD, seeded=True
    )
    with database.transaction() as connection:
        settlement_id = propose(connection, booking_id, cap=1000)
    with pytest.raises(DomainError, match="SETTLEMENT_NEEDS_APPROVAL"):
        await service.execute_settlement(
            database, client, booking_id, settlement_id, "agent"
        )
    assert fake.capture_calls == 0
    with database.transaction() as connection:
        tx.decide_settlement(
            connection, booking_id, settlement_id, "approved", "organizer"
        )
    await client.aclose()


ENV_FILE = Path(
    os.environ.get(
        "PAYPAL_ENV_FILE",
        str(Path(__file__).resolve().parents[2] / ".env.paypal.local"),
    )
)


@pytest.mark.paypal_sandbox
@pytest.mark.skipif(
    os.environ.get("RUN_PAYPAL_SANDBOX") != "1", reason="live sandbox opt-in"
)
async def test_live_sandbox_group_settlement(database) -> None:
    env = dict(
        line.split("=", 1)
        for line in ENV_FILE.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    client = PayPalClient(env["PAYPAL_CLIENT_ID"], env["PAYPAL_CLIENT_SECRET"])
    with database.transaction() as connection:
        booking_id = booking(connection, cap=5000)
    for name in ("Ana", "Ben"):
        _, outcome = await service.authorize_diver(
            database, client, booking_id, name, CARD, seeded=True
        )
        assert outcome == "succeeded"
    with database.transaction() as connection:
        settlement_id = propose(connection, booking_id, cap=5000)
    outcomes = await service.execute_settlement(
        database, client, booking_id, settlement_id, "agent"
    )
    assert set(outcomes.values()) == {"succeeded"}
    with database.transaction() as connection:
        states = {d["state"] for d in tx.divers(connection, booking_id)}
        assert states == {"captured"}
    await client.aclose()
