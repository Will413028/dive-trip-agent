import asyncio
import threading
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.service import RPCError, RPCStatusCode
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_budget import snapshot
from test_trip_transactions import owner

from dive_trip.application.agent_runtime import bind_worker_service
from dive_trip.application.delivery import FixtureDelivery
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.planning import PlanningService
from dive_trip.application.trips import TripService
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.planning.evidence import Binding

pytestmark = pytest.mark.integration


async def test_restart_delivers_product_commits_without_http_retry(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [entry.item for entry in trip.snapshot.entries])
    row, _ = service.start(identity, trip.id, "outbox", "fixture:move-tour", 1)
    binding = Binding(
        ownerId=identity, tripId=trip.id, runId=str(row["id"]), baseVersion=1
    )
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"delivery-{uuid4()}"
        dispatcher = FixtureDispatcher(service, environment.client, queue)
        delivery = FixtureDelivery(dispatcher)
        # Crash point: start transaction committed, no Temporal RPC was made.
        await delivery.sweep()
        handle = environment.client.get_workflow_handle(row["workflow_id"])
        with bind_worker_service(service):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                async with asyncio.timeout(20):
                    while not await handle.query(TripWorkflow.awaiting_confirmation):
                        await asyncio.sleep(0.05)
            with service.scope(binding, active=False) as (_, run, _):
                interrupt_id = run["interrupt_id"]
            # Crash point: receipt committed while worker is offline, no signal.
            receipt = service.decide(
                binding, interrupt_id, True, event_request_id=str(uuid4())
            )
            delivery = FixtureDelivery(
                FixtureDispatcher(service, environment.client, queue)
            )
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                async with asyncio.timeout(20):
                    while True:
                        await delivery.sweep()
                        with database.transaction() as connection:
                            delivered = connection.execute(
                                "SELECT decision_delivered FROM planning_executions"
                            ).fetchone()["decision_delivered"]
                        if delivered:
                            break
                        await asyncio.sleep(0.05)
                    assert await handle.result() == receipt
                await delivery.sweep()
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT current_version FROM trips").fetchone()[
                    "current_version"
                ]
                == 2
            )
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_model_steps"
                ).fetchone()["n"]
                == 2
            )
        assert delivery.claim() == []


async def test_undelivered_expired_start_is_fenced_without_workflow(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [])
    row, _ = service.start(identity, trip.id, "expired", "fixture:budget", 1)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE agent_runs SET "
            "lease_expires_at=clock_timestamp()-interval '1 second'"
        )
    async with await WorkflowEnvironment.start_local() as environment:
        delivery = FixtureDelivery(
            FixtureDispatcher(service, environment.client, "idle")
        )
        await delivery.sweep()
        with pytest.raises(RPCError) as failure:
            await environment.client.get_workflow_handle(row["workflow_id"]).describe()
        assert failure.value.status == RPCStatusCode.NOT_FOUND
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT status FROM agent_runs").fetchone()["status"]
                == "interrupted"
            )
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_model_steps"
                ).fetchone()["n"]
                == 0
            )


async def test_lost_start_ack_is_retried_from_durable_outbox(database, monkeypatch):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [])
    row, _ = service.start(identity, trip.id, "lost", "fixture:budget", 1)
    async with await WorkflowEnvironment.start_local() as environment:
        dispatcher = FixtureDispatcher(service, environment.client, "idle")
        original = environment.client.start_workflow

        async def lose_ack(*args, **kwargs):
            await original(*args, **kwargs)
            raise TimeoutError("synthetic")

        monkeypatch.setattr(environment.client, "start_workflow", lose_ack)
        delivery = FixtureDelivery(dispatcher)
        await delivery.sweep()
        assert delivery.claim() == []  # persistent backoff, not a hot retry loop
        handle = environment.client.get_workflow_handle(row["workflow_id"])
        first = await handle.describe()
        monkeypatch.setattr(environment.client, "start_workflow", original)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE planning_executions SET next_delivery_at=clock_timestamp()"
            )
        await FixtureDelivery(dispatcher).sweep()
        assert (await handle.describe()).run_id == first.run_id
        assert delivery.claim() == []


async def test_cancel_during_start_commit_cannot_be_revived_by_outbox(
    database, monkeypatch
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [])
    committed, release = threading.Event(), threading.Event()
    original = service.start

    def delayed_commit(*args, **kwargs):
        result = original(*args, **kwargs)
        committed.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(service, "start", delayed_commit)
    async with await WorkflowEnvironment.start_local() as environment:
        dispatcher = FixtureDispatcher(service, environment.client, "idle")
        task = asyncio.create_task(
            dispatcher.start(
                identity, trip.id, "cancel-before-stream", "fixture:budget", 1
            )
        )
        try:
            async with asyncio.timeout(5):
                while not committed.is_set():
                    await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.sleep(0.03)
            assert not task.done()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        delivery = FixtureDelivery(dispatcher)
        await delivery.sweep()
        with database.transaction() as connection:
            row = connection.execute(
                "SELECT r.status,e.* FROM agent_runs r "
                "JOIN planning_executions e ON e.run_id=r.id"
            ).fetchone()
            assert row["status"] == "interrupted"
            assert row["cancellation_delivered"] is True
            assert row["workflow_started"] is False
            assert row["model_steps"] == 0
        with pytest.raises(RPCError) as failure:
            await environment.client.get_workflow_handle(row["workflow_id"]).describe()
        assert failure.value.status == RPCStatusCode.NOT_FOUND


async def test_cancel_rpc_loss_is_recovered_without_new_start(database, monkeypatch):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [])
    async with await WorkflowEnvironment.start_local() as environment:
        dispatcher = FixtureDispatcher(service, environment.client, "idle")
        binding = await dispatcher.start(
            identity, trip.id, "cancel", "fixture:budget", 1
        )
        original = dispatcher.deliver_cancellation

        async def unavailable(_binding):
            raise TimeoutError("synthetic RPC loss")

        monkeypatch.setattr(dispatcher, "deliver_cancellation", unavailable)
        with pytest.raises(TimeoutError):
            await dispatcher.cancel(binding)
        monkeypatch.setattr(dispatcher, "deliver_cancellation", original)
        await FixtureDelivery(dispatcher).sweep()
        with database.transaction() as connection:
            assert (
                connection.execute(
                    "SELECT cancellation_delivered FROM planning_executions"
                ).fetchone()["cancellation_delivered"]
                is True
            )
        history = await environment.client.get_workflow_handle(
            f"dive-trip-v1:{binding.runId}"
        ).fetch_history()
        assert (
            sum(
                event.HasField("workflow_execution_cancel_requested_event_attributes")
                for event in history.events
            )
            == 1
        )
