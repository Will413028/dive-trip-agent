import asyncio
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from deletion_helpers import DELETE_SERVER_ARGS
from psycopg.conninfo import conninfo_to_dict
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.testing import WorkflowEnvironment
from test_chat_http import setup

from dive_trip.application.deletion import DeletionService
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.run_queries import RunQueries

pytestmark = pytest.mark.integration


async def test_os_worker_crash_replays_confirmation_without_models_and_runs_purge(
    database, tmp_path
):
    owner, token, trip, service = setup(database)
    queries = RunQueries(database)
    root = Path(__file__).resolve().parents[2]
    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()], dev_server_extra_args=DELETE_SERVER_ARGS
    ) as environment:
        queue = f"process-{uuid4().hex}"
        temporal_port = environment.client.service_client.config.target_host.rsplit(
            ":", 1
        )[-1]
        command = [
            sys.executable,
            "-m",
            "dive_trip.bootstrap.runtime",
            "--role",
            "worker",
            "--schema",
            database.schema,
            "--database-port",
            conninfo_to_dict(database.pool.conninfo)["port"],
            "--database-name",
            "postgres",
            "--temporal-port",
            temporal_port,
            "--task-queue",
            queue,
        ]
        with (tmp_path / "worker.log").open("w+") as log:

            def spawn():
                return subprocess.Popen(
                    command,
                    cwd=root,
                    stdout=log,
                    stderr=log,
                    stdin=subprocess.DEVNULL,
                    env={"PATH": "/usr/bin:/bin", "PYTHONUNBUFFERED": "1"},
                )

            worker = spawn()
            try:
                dispatcher = FixtureDispatcher(service, environment.client, queue)
                binding = await dispatcher.start(
                    owner, trip.id, "start", "fixture:move-tour", 1
                )
                async with asyncio.timeout(30):
                    while True:
                        assert worker.poll() is None, (
                            tmp_path / "worker.log"
                        ).read_text()
                        run = await asyncio.to_thread(
                            queries.get, owner, trip.id, binding.runId
                        )
                        if run["status"] == "awaiting_confirmation":
                            break
                        await asyncio.sleep(0.1)
                # Kill only the test-owned OS process, not a shared worker.
                worker.kill()
                await asyncio.to_thread(worker.wait, 5)
                receipt = await dispatcher.decide(
                    binding, run["interruptId"], True, event_request_id=str(uuid4())
                )
                worker = spawn()
                handle = environment.client.get_workflow_handle(
                    f"dive-trip-v1:{binding.runId}"
                )
                async with asyncio.timeout(30):
                    assert (
                        await handle.result(rpc_timeout=timedelta(seconds=20))
                        == receipt
                    )
                with database.transaction() as connection:
                    assert (
                        connection.execute(
                            "SELECT count(*) AS n FROM planning_model_steps"
                        ).fetchone()["n"]
                        == 2
                    )
                deletions = DeletionService(database)
                deletions.request(owner, trip.id)
                async with asyncio.timeout(20):
                    while await asyncio.to_thread(deletions.status, owner, trip.id) != {
                        "status": "deleted"
                    }:
                        assert worker.poll() is None, (
                            tmp_path / "worker.log"
                        ).read_text()
                        await asyncio.sleep(0.1)
            finally:
                if worker.poll() is None:
                    worker.terminate()
                    try:
                        await asyncio.to_thread(worker.wait, 10)
                    except subprocess.TimeoutExpired:
                        worker.kill()
                        await asyncio.to_thread(worker.wait, 5)


def test_runtime_rejects_retired_schema_before_connecting():
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "dive_trip.bootstrap.runtime",
            "--role",
            "worker",
            "--schema",
            "workbench_live",
            "--database-port",
            "1",
            "--temporal-port",
            "1",
            "--task-queue",
            "invalid",
        ],
        capture_output=True,
        text=True,
        timeout=15,
        env={"PATH": "/usr/bin:/bin"},
    )
    assert completed.returncode == 2
    assert "FIXTURE_SCHEMA_REQUIRED" in completed.stderr
    assert "FIXTURE_RUNTIME_FAILED" not in completed.stderr
