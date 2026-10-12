"""The judge's own deposit via PayPal checkout: order first, authorize on approval."""

import asyncio
import json

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from test_deposits_http import BOOKING, ORIGIN, RecordingWorkflows
from test_deposits_service import CARD, FakePayPal

from dive_trip.application import deposits as app
from dive_trip.bootstrap.deposits_api import create_deposits_app
from dive_trip.modules.deposits import service
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.paypal import PayPalClient

pytestmark = pytest.mark.integration


class CheckoutPayPal(FakePayPal):
    """Card orders authorize at once; checkout orders wait for buyer approval."""

    def __init__(self) -> None:
        super().__init__()
        self.authorize_keys: list[str] = []
        self.fail_orders = False
        self.declines = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if not path.startswith("/v2/checkout/orders"):
            return super().handle(request)
        body = json.loads(request.content) if request.content else {}
        key = request.headers.get("PayPal-Request-Id", "")
        if path == "/v2/checkout/orders" and "payment_source" not in body:
            if self.fail_orders:
                return httpx.Response(
                    422, json={"details": [{"issue": "AMOUNT_MISMATCH"}]}
                )
            self.amount = body["purchase_units"][0]["amount"]
            return httpx.Response(201, json={"id": "ORDER1234", "status": "CREATED"})
        if path == "/v2/checkout/orders/ORDER1234/authorize":
            self.authorize_keys.append(key)
            if self.declines:
                self.declines -= 1
                return httpx.Response(
                    422, json={"details": [{"issue": "INSTRUMENT_DECLINED"}]}
                )
            auth = {"id": "AUTH5678", "status": "CREATED", "amount": self.amount}
            return httpx.Response(
                201,
                json={
                    "id": "ORDER1234",
                    "purchase_units": [{"payments": {"authorizations": [auth]}}],
                },
            )
        return super().handle(request)


def build(database, fake: CheckoutPayPal, client_id: str | None = "sandbox-id"):
    paypal = PayPalClient("id", "s", transport=httpx.MockTransport(fake.handle))
    ctx = app.DepositsContext(
        database=database, paypal=paypal, seed_card=CARD, paypal_client_id=client_id
    )
    http = TestClient(
        create_deposits_app(database, ORIGIN, ctx, RecordingWorkflows(ctx)),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    )
    return http, ctx, paypal


def test_checkout_order_authorizes_only_after_buyer_approval(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        assert http.get("/api/deposits/config").json() == {
            "paypalClientId": "sandbox-id"
        }
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        started = http.post(f"{base}/checkout", json={"name": "Judge"}).json()
        assert started["orderId"] == "ORDER1234"
        pending = http.get(base).json()["divers"][-1]
        assert (pending["name"], pending["state"]) == ("Judge", "pending")

        wrong = http.post(
            f"{base}/divers/{started['diverId']}/authorize",
            json={"orderId": "ORDER9999"},
        )
        assert wrong.status_code == 409
        assert fake.authorize_keys == []

        done = http.post(
            f"{base}/divers/{started['diverId']}/authorize",
            json={"orderId": "ORDER1234"},
        ).json()
        judge = done["divers"][-1]
        assert (judge["state"], judge["authorizedMinor"]) == ("authorized", 20000)
        assert judge["authorizationId"] == "AUTH5678"
        assert len(fake.authorize_keys) == 1
    asyncio.run(paypal.aclose())


def test_failed_order_closes_the_hold_attempt(database) -> None:
    fake = CheckoutPayPal()
    http, ctx, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        fake.fail_orders = True
        failed = http.post(
            f"/api/deposits/bookings/{booking['id']}/checkout", json={"name": "Judge"}
        )
        assert failed.status_code == 409
        with database.transaction() as connection:
            assert tx.open_commands(connection, booking["id"]) == []
        # Trip start reconciliation is not blocked by the abandoned attempt.
        assert asyncio.run(service.reconcile(database, paypal, booking["id"])) == {}
    asyncio.run(paypal.aclose())


def test_reconcile_retries_an_unknown_checkout_authorization_with_its_key(
    database,
) -> None:
    fake = CheckoutPayPal()
    http, ctx, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        started = http.post(
            f"/api/deposits/bookings/{booking['id']}/checkout", json={"name": "Judge"}
        ).json()
        with database.transaction() as connection:
            [command] = tx.open_commands(connection, booking["id"])
            tx.complete_command(connection, str(command["id"]), "unknown")
        outcomes = asyncio.run(service.reconcile(database, paypal, booking["id"]))
        assert list(outcomes.values()) == ["succeeded"]
        assert fake.authorize_keys == [command["request_id"]]
        with database.transaction() as connection:
            judge = next(
                d
                for d in tx.divers(connection, booking["id"])
                if str(d["id"]) == started["diverId"]
            )
        assert judge["state"] == "authorized"
    asyncio.run(paypal.aclose())


def test_checkout_is_off_without_a_client_id(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal(), client_id=None)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        refused = http.post(
            f"/api/deposits/bookings/{booking['id']}/checkout", json={"name": "Judge"}
        )
        assert refused.status_code == 409
        assert refused.json() == {"error": "DEPOSIT_CHECKOUT_DISABLED"}
    asyncio.run(paypal.aclose())


def test_a_declined_card_is_reported_and_the_same_name_can_retry(database) -> None:
    fake = CheckoutPayPal()
    fake.declines = 1
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        first = http.post(f"{base}/checkout", json={"name": "Judge"}).json()
        declined = http.post(
            f"{base}/divers/{first['diverId']}/authorize",
            json={"orderId": first["orderId"]},
        )
        assert declined.status_code == 409
        assert declined.json() == {"error": "PAYPAL_INSTRUMENT_DECLINED"}

        again = http.post(f"{base}/checkout", json={"name": "Judge"}).json()
        assert again["diverId"] == first["diverId"]
        done = http.post(
            f"{base}/divers/{again['diverId']}/authorize",
            json={"orderId": again["orderId"]},
        ).json()
        judges = [d for d in done["divers"] if d["name"] == "Judge"]
        assert [d["state"] for d in judges] == ["authorized"]
        assert len(set(fake.authorize_keys)) == 2  # a new command, a new key
    asyncio.run(paypal.aclose())
