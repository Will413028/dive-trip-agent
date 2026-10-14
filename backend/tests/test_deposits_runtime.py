"""Demo-profile runtime: compose database settings and the pre-rebuild hold release."""

import argparse
from datetime import date

import httpx2 as httpx
import pytest
from psycopg.conninfo import conninfo_to_dict
from test_deposits_service import CARD, POLICY, FakePayPal, mandate

from dive_trip.application import deposits as app
from dive_trip.bootstrap.deposits_runtime import conninfo
from dive_trip.modules.deposits import service
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.paypal import PayPalClient


class VoidingPayPal(FakePayPal):
    def __init__(self) -> None:
        super().__init__()
        self.voided: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/void"):
            self.voided.append(request.url.path.split("/")[-2])
            return httpx.Response(204)
        return super().handle(request)


def namespace(**values: object) -> argparse.Namespace:
    return argparse.Namespace(
        database_port=5432, database_host=None, database_password_file=None, **values
    )


def test_compose_database_reads_the_password_from_a_file(tmp_path) -> None:
    secret = tmp_path / "db-password"
    secret.write_text("s3cret-value\n")
    parts = conninfo_to_dict(
        conninfo(
            argparse.Namespace(
                database_port=5432,
                database_host="db",
                database_password_file=str(secret),
            )
        )
    )
    assert (parts["host"], parts["user"], parts["dbname"]) == (
        "db",
        "deposits",
        "deposits",
    )
    assert parts["password"] == "s3cret-value"


def test_compose_database_host_must_be_a_service_name(tmp_path) -> None:
    secret = tmp_path / "db-password"
    secret.write_text("x")
    with pytest.raises(ValueError, match="INVALID_DATABASE_HOST"):
        conninfo(
            argparse.Namespace(
                database_port=5432,
                database_host="db.example.com",
                database_password_file=str(secret),
            )
        )


def test_without_a_host_the_loopback_fixture_is_used() -> None:
    assert conninfo_to_dict(conninfo(namespace()))["host"] == "127.0.0.1"


@pytest.mark.integration
async def test_void_all_holds_releases_every_open_authorization(database) -> None:
    fake = VoidingPayPal()
    fake.capture_calls = 1
    client = PayPalClient("id", "s", transport=httpx.MockTransport(fake.handle))
    ctx = app.DepositsContext(database=database, paypal=client, seed_card=CARD)
    for _ in range(2):
        await app.create_booking(
            ctx,
            workspace="judge",
            title="Boat dives",
            starts_on=date(2026, 11, 20),
            site=(22.33, 120.37),
            policy=POLICY,
            mandate=mandate(5000),
            seed_divers=2,
        )
    outcomes = await service.void_all_holds(database, client)
    assert list(outcomes.values()) == ["succeeded"] * 4
    assert len(set(fake.voided)) == 4
    with database.transaction() as connection:
        states = {
            row["state"]
            for booking_id in tx.workspace_bookings(connection, "judge")
            for row in tx.divers(connection, booking_id)
        }
    assert states == {"voided"}
    assert await service.void_all_holds(database, client) == {}
    await client.aclose()
