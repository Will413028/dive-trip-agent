import asyncio
from datetime import datetime

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from test_deposits_service import CARD, FakePayPal

from dive_trip.application import deposits as app
from dive_trip.bootstrap.deposits_api import create_deposits_app
from dive_trip.modules.deposits.paypal import PayPalClient

pytestmark = pytest.mark.integration
ORIGIN = "http://localhost:3000"

BOOKING = {
    "title": "Two-day boat dives",
    "startsOn": "2026-11-20",
    "tripDays": 2,
    "siteLat": 8.1,
    "siteLon": 98.3,
    "depositMinor": 20000,
    "rules": [{"cause": "weather", "refundPercent": 100}],
    "mandate": {
        "autoMaxPerDiverMinor": 15000,
        "autoMaxPerBookingMinor": 100000,
        "allowedActions": ["void", "partial_capture", "capture", "refund"],
        "allowedCauses": ["weather"],
        "expiresOn": "2099-12-31",
    },
    "seedDivers": 2,
}


class RecordingWorkflows:
    """Stands in for Temporal; check_now runs the assessment inline."""

    def __init__(self, ctx: app.DepositsContext) -> None:
        self.ctx = ctx
        self.calls: list[tuple[str, str]] = []

    async def start(self, booking_id: str, settle_at: datetime) -> None:
        self.calls.append(("start", settle_at.isoformat()))

    async def check_now(self, booking_id: str) -> None:
        self.calls.append(("check", booking_id))
        await app.assess(self.ctx, booking_id)

    async def approve(self, booking_id: str, settlement_id: str) -> None:
        self.calls.append(("approve", settlement_id))

    async def stop(self, booking_id: str) -> None:
        self.calls.append(("stop", booking_id))


class AlwaysCaptures(FakePayPal):
    def __init__(self) -> None:
        super().__init__()
        self.capture_calls = 1


def build(database):
    paypal = PayPalClient(
        "id", "s", transport=httpx.MockTransport(AlwaysCaptures().handle)
    )
    ctx = app.DepositsContext(database=database, paypal=paypal, seed_card=CARD)
    workflows = RecordingWorkflows(ctx)
    client = TestClient(
        create_deposits_app(database, ORIGIN, ctx, workflows),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    )
    return client, workflows, paypal


def test_judge_flow_and_workspace_isolation(database) -> None:
    client, workflows, paypal = build(database)
    with client:
        booking = client.post("/api/deposits/bookings", json=BOOKING).json()
        assert [d["state"] for d in booking["divers"]] == ["authorized"] * 2
        assert workflows.calls[0] == ("start", "2026-11-20T00:00:00+00:00")

        joined = client.post(
            f"/api/deposits/bookings/{booking['id']}/join", json={"name": "Judge"}
        ).json()
        assert len(joined["divers"]) == 3 and not joined["divers"][-1]["seeded"]

        client.post(
            f"/api/deposits/bookings/{booking['id']}/simulate-storm",
            json={"cancelledDays": [2]},
        )
        checked = client.post(f"/api/deposits/bookings/{booking['id']}/check", json={})
        assert checked.status_code == 200 and checked.json() == {"requested": True}
        current = client.get(f"/api/deposits/bookings/{booking['id']}").json()
        [settlement] = current["settlements"]
        assert settlement["source"] == "no_ai" and settlement["status"] == "proposed"

        decided = client.post(
            f"/api/deposits/bookings/{booking['id']}/settlements/{settlement['id']}",
            json={"decision": "approve"},
        ).json()
        assert decided["settlements"][0]["status"] == "approved"
        assert workflows.calls[-1] == ("approve", settlement["id"])

        with TestClient(
            client.app, base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as stranger:
            assert (
                stranger.get(f"/api/deposits/bookings/{booking['id']}").status_code
                == 404
            )
            assert stranger.get("/api/deposits/bookings").json() == []

        reset = client.post("/api/deposits/reset", json={})
        assert reset.status_code == 200 and reset.json() == {"deleted": 1}
        assert client.get("/api/deposits/bookings").json() == []
    asyncio.run(paypal.aclose())


def test_invalid_mandate_payload_is_rejected(database) -> None:
    client, _, paypal = build(database)
    with client:
        bad = {**BOOKING, "mandate": {**BOOKING["mandate"], "allowedCauses": ["x"]}}
        assert client.post("/api/deposits/bookings", json=bad).status_code == 400
    asyncio.run(paypal.aclose())


def test_demo_profile_mounts_only_session_backed_deposit_routes(database) -> None:
    client, _, paypal = build(database)
    paths = {getattr(route, "path", "") for route in client.app.routes}
    api = {path for path in paths if path.startswith("/api/")}
    assert api and all(path.startswith("/api/deposits/") for path in api)
    asyncio.run(paypal.aclose())
