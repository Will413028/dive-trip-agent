import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporal_probe import ContractProbe
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

pytestmark = pytest.mark.integration


async def test_worker_restart_replays_result_without_new_model_activity():
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        queue = f"dive-contract-{uuid4().hex}"
        async with Worker(
            environment.client, task_queue=queue, workflows=[ContractProbe]
        ):
            handle = await environment.client.start_workflow(
                ContractProbe.run,
                id=f"probe-{uuid4().hex}",
                task_queue=queue,
                execution_timeout=timedelta(seconds=45),
            )
            async with asyncio.timeout(20):
                while not await handle.query(ContractProbe.awaiting_confirmation):
                    await asyncio.sleep(0.05)
        # A fresh worker must replay the completed model activity and wait state.
        async with Worker(
            environment.client, task_queue=queue, workflows=[ContractProbe]
        ):
            await handle.signal(ContractProbe.decide, True)
            result = await handle.result()
            assert result == {
                "plan": {
                    "version": "1",
                    "answer": {"kind": "clarify", "fields": ["budget"]},
                },
                "receipt": {"status": "applied", "version": 2},
            }
            history = await handle.fetch_history()
        scheduled = [
            event.activity_task_scheduled_event_attributes
            for event in history.events
            if event.HasField("activity_task_scheduled_event_attributes")
        ]
        model_activities = [
            activity for activity in scheduled if "model" in activity.activity_type.name
        ]
        assert len(model_activities) == 1
        assert model_activities[0].retry_policy.maximum_attempts == 1
