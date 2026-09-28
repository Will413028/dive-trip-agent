import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from test_budget import snapshot
from test_trip_transactions import owner

from dive_trip.application.agent_runtime import bind_worker_service
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.planning import PlanningService
from dive_trip.application.trips import TripService
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.planning.evidence import Binding

pytestmark = pytest.mark.integration


async def test_durable_product_proposal_and_committed_receipt_after_worker_restart(
    database,
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [entry.item for entry in trip.snapshot.entries])
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        row, _ = service.start(identity, trip.id, "start", "fixture:move-tour", 1)
        binding = Binding(
            ownerId=identity, tripId=trip.id, runId=str(row["id"]), baseVersion=1
        )
        queue = f"dive-product-{uuid4().hex}"
        with bind_worker_service(service):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                handle = await environment.client.start_workflow(
                    TripWorkflow.run,
                    id=row["workflow_id"],
                    task_queue=queue,
                    execution_timeout=timedelta(seconds=60),
                )
                async with asyncio.timeout(30):
                    while not await handle.query(TripWorkflow.awaiting_confirmation):
                        await asyncio.sleep(0.05)
            with database.transaction() as connection:
                pending = connection.execute(
                    "SELECT status,interrupt_id FROM agent_runs WHERE id=%s",
                    (binding.runId,),
                ).fetchone()
                assert pending["status"] == "awaiting_confirmation"
            # Commit while the worker is offline; waking a fresh worker must only
            # read the immutable receipt and replay the earlier model history.
            committed = await asyncio.to_thread(
                service.decide,
                binding,
                pending["interrupt_id"],
                True,
                event_request_id=str(uuid4()),
            )
            await handle.signal(TripWorkflow.decision_committed)
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                async with asyncio.timeout(20):
                    assert await handle.result() == committed
                history = await handle.fetch_history()
        with database.transaction() as connection:
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_model_steps"
                ).fetchone()["n"]
                == 2
            )
            assert (
                connection.execute("SELECT current_version FROM trips").fetchone()[
                    "current_version"
                ]
                == 2
            )
        scheduled = [
            event.activity_task_scheduled_event_attributes
            for event in history.events
            if event.HasField("activity_task_scheduled_event_attributes")
        ]
        models = [item for item in scheduled if "model" in item.activity_type.name]
        assert len(models) == 2
        assert all(item.retry_policy.maximum_attempts == 1 for item in scheduled)


async def test_lost_start_ack_reconciles_one_workflow_without_redispatch(
    database, monkeypatch
):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = PlanningService(database, [entry.item for entry in trip.snapshot.entries])
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"dive-ack-{uuid4().hex}"
        dispatcher = FixtureDispatcher(service, environment.client, queue)
        original = environment.client.start_workflow

        async def lost_ack(*args, **kwargs):
            await original(*args, **kwargs)
            raise TimeoutError("synthetic lost ACK")

        monkeypatch.setattr(environment.client, "start_workflow", lost_ack)
        with pytest.raises(TimeoutError, match="synthetic lost ACK"):
            await dispatcher.start(identity, trip.id, "same", "fixture:budget", 1)
        monkeypatch.setattr(environment.client, "start_workflow", original)
        binding = await dispatcher.start(identity, trip.id, "same", "fixture:budget", 1)
        with bind_worker_service(service):
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                async with asyncio.timeout(20):
                    answer = await environment.client.get_workflow_handle(
                        f"dive-trip-v1:{binding.runId}"
                    ).result()
                assert answer["body"]["kind"] == "budget"
        assert (
            await dispatcher.start(identity, trip.id, "same", "fixture:budget", 1)
            == binding
        )
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT count(*) AS n FROM agent_runs").fetchone()[
                    "n"
                ]
                == 1
            )
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM planning_model_steps"
                ).fetchone()["n"]
                == 2
            )
