"""A diver joins once; each deposit hold attempt is a child that can be replaced.

Regression: a judge who opened the card form (which starts a checkout order) and then
used the server's test card under the same name got a 503 from a duplicate insert.
"""

import asyncio
import threading
import time
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_deposits_checkout import CheckoutPayPal, build, start
from test_deposits_http import BOOKING, ORIGIN
from test_deposits_service import CARD

from dive_trip.modules.deposits import service
from dive_trip.modules.deposits import transactions as tx
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration
MIGRATION = Path(__file__).resolve().parents[2] / "migrations" / "deposits"


def waits_on_a_lock(database) -> bool:
    """True once the send is waiting on a row lock (polled, not timed)."""
    for _ in range(200):
        with database.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' "
                "AND query LIKE '%SET sent_at%'"
            ).fetchone():
                return True
        time.sleep(0.05)
    return False


def authorize_commands(database, booking_id: str) -> list[dict]:
    with database.transaction() as connection:
        return connection.execute(
            "SELECT status,error_code,method FROM deposit_money_commands "
            "WHERE booking_id=%s AND kind='authorize' AND method='checkout' "
            "ORDER BY created_at",
            (booking_id,),
        ).fetchall()


def test_test_card_after_an_abandoned_checkout_places_the_hold(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        started = start(http, base)

        diver = http.post(f"{base}/divers", json={"name": "Judge"}).json()["diverId"]
        assert diver == started["diverId"]
        held = http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        assert held.status_code == 200, held.json()
        judges = [d for d in held.json()["divers"] if d["name"] == "Judge"]
        assert [d["state"] for d in judges] == ["authorized"]
        assert [
            (c["status"], c["error_code"])
            for c in authorize_commands(database, booking["id"])
        ] == [("rejected", "CHECKOUT_REPLACED")]

        # The buyer approves the abandoned order later: no second hold is placed.
        late = http.post(
            f"{base}/divers/{diver}/authorize", json={"orderId": started["orderId"]}
        )
        assert late.status_code == 409
        assert late.json() == {"error": "DEPOSIT_ATTEMPT_CLOSED"}
        assert fake.authorize_keys == []
    asyncio.run(paypal.aclose())


def test_reopening_the_card_form_replaces_the_unfinished_order(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        first = start(http, base)
        second = start(http, base)
        assert second["diverId"] == first["diverId"]
        assert second["orderId"] != first["orderId"]
        done = http.post(
            f"{base}/divers/{second['diverId']}/authorize",
            json={"orderId": second["orderId"]},
        ).json()
        judges = [d for d in done["divers"] if d["name"] == "Judge"]
        assert [d["state"] for d in judges] == ["authorized"]
        assert [c["status"] for c in authorize_commands(database, booking["id"])] == [
            "rejected",
            "succeeded",
        ]
        assert fake.authorized_orders == [second["orderId"]]
        with database.transaction() as connection:
            assert tx.open_commands(connection, booking["id"]) == []
    asyncio.run(paypal.aclose())


def test_a_name_that_holds_a_deposit_or_is_seeded_is_taken(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        seeded = booking["divers"][0]["name"]
        taken = http.post(f"{base}/divers", json={"name": seeded})
        assert (taken.status_code, taken.json()) == (
            409,
            {"error": "DEPOSIT_NAME_TAKEN"},
        )
        diver = http.post(f"{base}/divers", json={"name": "Judge"}).json()["diverId"]
        http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        held = http.post(f"{base}/divers", json={"name": "Judge"})
        assert (held.status_code, held.json()) == (409, {"error": "DEPOSIT_NAME_TAKEN"})
        again = http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        assert again.json() == {"error": "DEPOSIT_ALREADY_HELD"}
    asyncio.run(paypal.aclose())


def test_an_attempt_already_sent_to_paypal_blocks_a_new_one(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        started = start(http, base)
        with database.transaction() as connection:
            [command] = tx.open_commands(connection, booking["id"])
            tx.claim_command(connection, str(command["id"]))  # authorize in flight
        blocked = http.post(
            f"{base}/divers/{started['diverId']}/test-card-hold", json={}
        )
        assert (blocked.status_code, blocked.json()) == (
            409,
            {"error": "DEPOSIT_HOLD_IN_FLIGHT"},
        )
        with database.transaction() as connection:
            assert [
                str(c["id"]) for c in tx.open_commands(connection, booking["id"])
            ] == [str(command["id"])]
    asyncio.run(paypal.aclose())


def test_a_replacement_and_a_send_never_both_win(database) -> None:
    """The replacing transaction holds the attempt's row; the send waits, then sees it
    closed, so an order replaced mid-flight is never authorized."""
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        started = start(http, f"/api/deposits/bookings/{booking['id']}")
    with database.transaction() as connection:
        [command] = tx.open_commands(connection, booking["id"])
    outcome: list[str] = []

    def send() -> None:
        try:
            with database.transaction() as connection:
                tx.claim_command(connection, str(command["id"]))
            outcome.append("claimed")
        except DomainError as error:
            outcome.append(error.code)

    with database.transaction() as connection:
        tx.open_hold_attempt(connection, booking["id"], started["diverId"], "test_card")
        sender = threading.Thread(target=send)
        sender.start()
        assert waits_on_a_lock(database)  # the send is blocked on the attempt's row
    sender.join(timeout=10)
    assert outcome == ["MONEY_COMMAND_NOT_OPEN"]
    asyncio.run(paypal.aclose())


def test_a_diver_of_another_booking_is_not_found(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        one = http.post("/api/deposits/bookings", json=BOOKING).json()
        other = http.post("/api/deposits/bookings", json=BOOKING).json()
        diver = one["divers"][0]["id"]
        wrong = http.post(
            f"/api/deposits/bookings/{other['id']}/divers/{diver}/test-card-hold",
            json={},
        )
        assert wrong.status_code == 404
    asyncio.run(paypal.aclose())


def test_hold_attempts_migration_refuses_existing_demo_data(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        http.post("/api/deposits/bookings", json=BOOKING)
    sql = (MIGRATION / "003-hold-attempts.sql").read_text()
    with pytest.raises(psycopg.errors.RaiseException, match="FRESH_DATABASE"):
        with database.transaction() as connection:
            connection.execute(sql)
    asyncio.run(paypal.aclose())


def test_a_bug_is_an_internal_error_and_only_an_outage_is_unavailable(
    database, monkeypatch
) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
    client = TestClient(
        http.app,
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
        cookies=http.cookies,
        raise_server_exceptions=False,
    )
    url = f"/api/deposits/bookings/{booking['id']}/divers"

    def fail(error: Exception):
        def raises(*args, **kwargs):
            raise error

        return raises

    with client:
        monkeypatch.setattr(tx, "join_diver", fail(RuntimeError("bug")))
        bug = client.post(url, json={"name": "Judge"})
        assert (bug.status_code, bug.json()) == (500, {"error": "INTERNAL_ERROR"})
        monkeypatch.setattr(tx, "join_diver", fail(psycopg.OperationalError("down")))
        down = client.post(url, json={"name": "Judge"})
        assert (down.status_code, down.json()) == (
            503,
            {"error": "SERVICE_UNAVAILABLE"},
        )
    asyncio.run(paypal.aclose())


def unknown_test_card_attempt(database, booking_id: str, name: str) -> str:
    """A test-card hold whose answer never arrived: PayPal may hold the deposit."""
    with database.transaction() as connection:
        diver = tx.join_diver(connection, booking_id, name, seeded=False)
        command = tx.open_hold_attempt(connection, booking_id, diver, "test_card")
        tx.claim_command(connection, str(command["id"]))
        tx.complete_command(connection, str(command["id"]), "unknown")
    return diver


def diver_state(database, booking_id: str, diver_id: str) -> str:
    with database.transaction() as connection:
        return next(
            d["state"]
            for d in tx.divers(connection, booking_id)
            if str(d["id"]) == diver_id
        )


def test_reconcile_retries_each_attempt_the_way_it_was_paid(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        card_diver = unknown_test_card_attempt(database, booking["id"], "Card")
        # The buyer approved, but onApprove never reached the server.
        approved = start(http, base, "Approved")
        abandoned = start(http, base, "Abandoned")
        fake.approved = {approved["orderId"]}

        without_card = asyncio.run(service.reconcile(database, paypal, booking["id"]))
        assert sorted(without_card.values()) == [
            "DEPOSIT_CARD_REQUIRED",
            "rejected",
            "succeeded",
        ]  # one command that cannot be sent does not stop the others
        assert diver_state(database, booking["id"], approved["diverId"]) == "authorized"
        assert diver_state(database, booking["id"], abandoned["diverId"]) == "pending"

        with_card = asyncio.run(
            service.reconcile(database, paypal, booking["id"], CARD)
        )
        assert list(with_card.values()) == ["succeeded"]
        assert diver_state(database, booking["id"], card_diver) == "authorized"
        # The abandoned diver can pay again.
        retry = http.post(
            f"{base}/divers/{abandoned['diverId']}/test-card-hold", json={}
        )
        assert retry.status_code == 200, retry.json()
    asyncio.run(paypal.aclose())


def test_an_unexpected_paypal_answer_keeps_the_attempt_open(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        diver = http.post(f"{base}/divers", json={"name": "Judge"}).json()["diverId"]
        fake.card_status = "PENDING"
        held = http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        assert (held.status_code, held.json()) == (
            503,
            {"error": "PAYPAL_OUTCOME_UNKNOWN"},
        )
        with database.transaction() as connection:
            [command] = tx.open_commands(connection, booking["id"])
        assert (command["status"], command["error_code"]) == (
            "unknown",
            "PAYPAL_AUTHORIZATION_UNEXPECTED",
        )
        blocked = http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        assert blocked.json() == {"error": "DEPOSIT_HOLD_IN_FLIGHT"}
    asyncio.run(paypal.aclose())


def test_reset_records_and_releases_a_hold_whose_answer_was_lost(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        unknown_test_card_attempt(database, booking["id"], "Lost")
        assert http.post("/api/deposits/reset", json={}).json() == {
            "deleted": 1,
            "kept": 0,
        }
        # Two seeded holds plus the one whose answer was lost are all voided.
        assert len(fake.voids) == len(booking["divers"]) + 1
    asyncio.run(paypal.aclose())


def test_a_malformed_id_is_a_bad_request(database) -> None:
    http, _, paypal = build(database, CheckoutPayPal())
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        bad = http.post(
            f"/api/deposits/bookings/{booking['id']}/divers/not-a-uuid/test-card-hold",
            json={},
        )
        assert bad.status_code == 400
    asyncio.run(paypal.aclose())


def test_reset_keeps_a_booking_whose_hold_is_still_unconfirmed(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        unknown_test_card_attempt(database, booking["id"], "Lost")
        fake.card_status = "PENDING"  # the retry still cannot be recorded
        assert http.post("/api/deposits/reset", json={}).json() == {
            "deleted": 0,
            "kept": 1,
        }
        assert [b["id"] for b in http.get("/api/deposits/bookings").json()] == [
            booking["id"]
        ]
    asyncio.run(paypal.aclose())


def test_an_unreadable_paypal_answer_is_unknown_not_failed(database) -> None:
    fake = CheckoutPayPal()
    http, _, paypal = build(database, fake)
    with http:
        booking = http.post("/api/deposits/bookings", json=BOOKING).json()
        base = f"/api/deposits/bookings/{booking['id']}"
        diver = http.post(f"{base}/divers", json={"name": "Judge"}).json()["diverId"]
        fake.unreadable = True
        held = http.post(f"{base}/divers/{diver}/test-card-hold", json={})
        assert held.status_code == 503
        with database.transaction() as connection:
            [command] = tx.open_commands(connection, booking["id"])
        assert (command["status"], command["error_code"]) == (
            "unknown",
            "PAYPAL_RESPONSE_UNREADABLE",
        )
    asyncio.run(paypal.aclose())
