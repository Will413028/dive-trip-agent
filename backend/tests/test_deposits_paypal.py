import json
import os
import time
from pathlib import Path

import httpx2 as httpx
import pytest

from dive_trip.modules.deposits.paypal import (
    PayPalClient,
    PayPalError,
    PayPalUnknownOutcome,
    SandboxCard,
    minor_of,
    usd,
)

CARD = SandboxCard("4111111111111111", "2030-12", "123", "Test Diver")


def test_money_formatting_round_trips() -> None:
    for minor in (0, 1, 99, 100, 6667, 10000, 123456):
        assert minor_of(usd(minor)) == minor
    assert usd(6667) == {"currency_code": "USD", "value": "66.67"}
    assert minor_of({"currency_code": "USD", "value": "30"}) == 3000


def fake_paypal(seen: list[httpx.Request], capture_status: int = 201) -> PayPalClient:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.url.path == "/v2/checkout/orders":
            amount = json.loads(request.content)["purchase_units"][0]["amount"]
            auth = {"id": "A1", "status": "CREATED", "amount": amount}
            return httpx.Response(
                201,
                json={
                    "id": "O1",
                    "status": "COMPLETED",
                    "purchase_units": [{"payments": {"authorizations": [auth]}}],
                },
            )
        if request.url.path.endswith("/capture"):
            if capture_status != 201:
                return httpx.Response(
                    capture_status,
                    json={"details": [{"issue": "AUTHORIZATION_ALREADY_CAPTURED"}]},
                )
            amount = json.loads(request.content)["amount"]
            return httpx.Response(
                201, json={"id": "C1", "status": "COMPLETED", "amount": amount}
            )
        return httpx.Response(503)

    return PayPalClient("id", "secret", transport=httpx.MockTransport(handle))


async def test_card_authorization_sends_request_id_and_parses_hold() -> None:
    seen: list[httpx.Request] = []
    client = fake_paypal(seen)
    auth = await client.create_card_authorization(
        invoice_id="inv-1", amount_minor=10000, card=CARD, request_id="key-1"
    )
    assert (auth.authorizationId, auth.status, auth.amountMinor) == (
        "A1",
        "CREATED",
        10000,
    )
    order_request = seen[-1]
    assert order_request.headers["PayPal-Request-Id"] == "key-1"
    assert json.loads(order_request.content)["intent"] == "AUTHORIZE"
    await client.aclose()


async def test_rejection_and_unknown_outcome_are_distinct() -> None:
    seen: list[httpx.Request] = []
    rejected = fake_paypal(seen, capture_status=422)
    with pytest.raises(PayPalError) as error:
        await rejected.capture(
            "A1", amount_minor=3000, final=True, invoice_id="i", request_id="k"
        )
    assert error.value.code == "PAYPAL_AUTHORIZATION_ALREADY_CAPTURED"
    with pytest.raises(PayPalUnknownOutcome):
        await rejected.void("A1", request_id="k2")
    await rejected.aclose()


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
async def test_live_sandbox_partial_capture_is_idempotent_and_final() -> None:
    env = dict(
        line.split("=", 1)
        for line in ENV_FILE.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    client = PayPalClient(env["PAYPAL_CLIENT_ID"], env["PAYPAL_CLIENT_SECRET"])
    stamp = time.time_ns()
    auth = await client.create_card_authorization(
        invoice_id=f"test-{stamp}",
        amount_minor=10000,
        card=CARD,
        request_id=f"order-{stamp}",
    )
    assert auth.status == "CREATED"
    first = await client.capture(
        auth.authorizationId,
        amount_minor=3000,
        final=True,
        invoice_id=f"cap-{stamp}",
        request_id=f"cap-{stamp}",
    )
    retry = await client.capture(
        auth.authorizationId,
        amount_minor=3000,
        final=True,
        invoice_id=f"cap-{stamp}",
        request_id=f"cap-{stamp}",
    )
    assert retry.captureId == first.captureId
    state = await client.get_authorization(auth.authorizationId)
    assert state["status"] == "CAPTURED"
    refund = await client.refund(
        first.captureId,
        amount_minor=1000,
        invoice_id=f"rf-{stamp}",
        request_id=f"rf-{stamp}",
    )
    assert (refund.status, refund.amountMinor) == ("COMPLETED", 1000)
    await client.aclose()
