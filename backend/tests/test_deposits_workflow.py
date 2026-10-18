import asyncio
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import httpx2 as httpx
import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_deposits_service import CARD, FakePayPal

from dive_trip.application import deposits as app
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.domain import CauseRule, Mandate, RefundPolicy
from dive_trip.modules.deposits.paypal import PayPalClient

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
    autoMaxPerBookingMinor=50000,
    allowedActions=["void", "partial_capture", "capture", "refund"],
    allowedCauses=["weather"],
    expiresOn="2099-12-31",
)


class AlwaysCaptures(FakePayPal):
    def __init__(self) -> None:
        super().__init__()
        self.capture_calls = 1  # skip the simulated first-attempt timeout


async def wait_for(predicate, seconds: float = 20.0) -> None:
    async with asyncio.timeout(seconds):
        while not predicate():
            await asyncio.sleep(0.1)


async def start(environment, booking_id: str, settle_at: datetime, queue: str):
    return await environment.client.start_workflow(
        app.GroupBookingWorkflow.run,
        args=[booking_id, settle_at.isoformat()],
        id=f"deposits-{booking_id}",
        task_queue=queue,
        execution_timeout=timedelta(minutes=2),
    )


async def test_no_ai_proposal_waits_for_the_organizer_then_captures(database):
    client = PayPalClient(
        "id", "s", transport=httpx.MockTransport(AlwaysCaptures().handle)
    )
    ctx = app.DepositsContext(database=database, paypal=client, seed_card=CARD)
    app.bind_deposits(ctx)
    booking_id = await app.create_booking(
        ctx,
        workspace="judge",
        title="Boat dives",
        starts_on=date(2026, 11, 20),
        site=(22.33, 120.37),
        policy=POLICY,
        mandate=MANDATE,
        seed_divers=2,
    )
    with database.transaction() as connection:
        tx.add_evidence(
            connection,
            booking_id,
            "simulated",
            "Simulated storm: day 2 boats cancelled",
            {"cancelledDays": [2]},
        )
    queue = f"deposits-{uuid4().hex}"
    async with await WorkflowEnvironment.start_local() as environment:
        async with Worker(
            environment.client,
            task_queue=queue,
            workflows=[app.GroupBookingWorkflow],
            activities=app.DEPOSIT_ACTIVITIES,
        ):
            handle = await start(
                environment, booking_id, datetime.now(UTC) + timedelta(hours=1), queue
            )
            await handle.signal(app.GroupBookingWorkflow.check_now)

            def proposed() -> list[dict]:
                with database.transaction() as connection:
                    return tx.settlements(connection, booking_id)

            await wait_for(lambda: len(proposed()) == 1)
            [settlement] = proposed()
            assert settlement["source"] == "no_ai"
            assert settlement["status"] == "proposed"
            assert "NO_AI_NEEDS_APPROVAL" in settlement["reasons"]

            with database.transaction() as connection:
                tx.decide_settlement(
                    connection,
                    booking_id,
                    str(settlement["id"]),
                    "approved",
                    "organizer",
                )
            await handle.signal(app.GroupBookingWorkflow.approve, str(settlement["id"]))

            def states() -> set[tuple[str, int]]:
                with database.transaction() as connection:
                    return {
                        (row["state"], row["captured_minor"])
                        for row in tx.divers(connection, booking_id)
                    }

            await wait_for(lambda: states() == {("captured", 6667)})
            await handle.terminate()
    app.bind_deposits(None)
    await client.aclose()


async def test_trip_start_captures_held_deposits_in_full(database):
    client = PayPalClient(
        "id", "s", transport=httpx.MockTransport(AlwaysCaptures().handle)
    )
    ctx = app.DepositsContext(database=database, paypal=client, seed_card=CARD)
    app.bind_deposits(ctx)
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
    queue = f"deposits-{uuid4().hex}"
    async with await WorkflowEnvironment.start_local() as environment:
        async with Worker(
            environment.client,
            task_queue=queue,
            workflows=[app.GroupBookingWorkflow],
            activities=app.DEPOSIT_ACTIVITIES,
        ):
            handle = await start(
                environment, booking_id, datetime.now(UTC) + timedelta(seconds=2), queue
            )
            assert await handle.result() == "finalized"
    with database.transaction() as connection:
        [diver] = tx.divers(connection, booking_id)
        assert (diver["state"], diver["captured_minor"]) == ("captured", 10000)
    app.bind_deposits(None)
    await client.aclose()
