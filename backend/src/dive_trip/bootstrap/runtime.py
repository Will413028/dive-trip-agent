"""Explicit loopback fixture runtime; never discovers env files or credentials."""

import argparse
import asyncio
import json
import logging
import re
import signal
from pathlib import Path

import uvicorn
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import Client
from temporalio.worker import Worker

from dive_trip.application.agent_runtime import bind_worker_service
from dive_trip.application.deletion import DeletionService, DeletionWorker
from dive_trip.application.delivery import FixtureDelivery
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.planning import PlanningService
from dive_trip.application.retention import RetentionService
from dive_trip.application.runtime_binding import bind_temporal
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.catalog.public import load_catalog
from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.db_async import run_db
from dive_trip.platform.migrations import require_current

from .api import create_app


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("api", "worker"), required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument(
        "--database-name",
        choices=("dive_trip_test", "postgres"),
        default="dive_trip_test",
    )
    parser.add_argument("--temporal-port", type=int, required=True)
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--task-queue", required=True)
    parser.add_argument("--port", type=int, default=4320)
    parser.add_argument("--origin", default="http://127.0.0.1:4318")
    args = parser.parse_args()
    # Validate scope before touching database, Temporal or model configuration.
    if args.schema != "workbench_demo" and not re.fullmatch(
        r"(?:python_test|e2e)_[a-f0-9]{32}", args.schema
    ):
        parser.error("FIXTURE_SCHEMA_REQUIRED")
    if args.database_name == "postgres" and not args.schema.startswith("python_test_"):
        parser.error("DEDICATED_TEST_DATABASE_REQUIRED")
    if any(
        not 1 <= port <= 65535
        for port in (args.database_port, args.temporal_port, args.port)
    ):
        parser.error("INVALID_PORT")
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", args.origin):
        parser.error("LOOPBACK_ORIGIN_REQUIRED")
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", args.task_queue):
        parser.error("INVALID_TASK_QUEUE")
    return args


async def cleanup_loop(worker: DeletionWorker, stopped: asyncio.Event) -> None:
    retention = RetentionService(worker.service.database)
    while not stopped.is_set():
        await run_db(retention.request_expired)
        result = await worker.sweep()
        await run_db(retention.compact)
        if result["deleted"] or result["pending"] or result["prunedReceipts"]:
            logging.getLogger(__name__).info("DELETION_SWEEP %s", result)
        try:
            await asyncio.wait_for(stopped.wait(), timeout=5)
        except TimeoutError:
            pass


async def delivery_loop(delivery: FixtureDelivery, stopped: asyncio.Event) -> None:
    while not stopped.is_set():
        await delivery.sweep()
        try:
            await asyncio.wait_for(stopped.wait(), timeout=1)
        except TimeoutError:
            pass


async def run(args: argparse.Namespace) -> None:
    database = Database(
        fixture_conninfo(args.database_port, args.database_name),
        args.schema,
    )
    database.open()
    try:
        with database.transaction() as connection:
            target = connection.execute("SELECT current_database() AS name").fetchone()
            if target is None or target["name"] != args.database_name:
                raise ValueError("DATABASE_TARGET_MISMATCH")
        require_current(database)
        root = Path(__file__).resolve().parents[4]
        catalog = load_catalog(json.loads((root / "data/catalog.json").read_text()))
        service = PlanningService(database, catalog)
        client = await Client.connect(
            f"127.0.0.1:{args.temporal_port}",
            namespace=args.namespace,
            plugins=[PydanticAIPlugin()],
        )
        if args.schema == "workbench_demo":
            await bind_temporal(database, client)
        if args.role == "api":
            app = create_app(
                database,
                catalog,
                args.origin,
                dispatcher=FixtureDispatcher(service, client, args.task_queue),
            )
            server = uvicorn.Server(
                uvicorn.Config(
                    app,
                    host="127.0.0.1",
                    port=args.port,
                    access_log=False,
                    timeout_graceful_shutdown=20,
                )
            )
            await server.serve()
        else:
            stopped = asyncio.Event()
            loop = asyncio.get_running_loop()
            for signum in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(signum, stopped.set)
            with bind_worker_service(service):
                async with Worker(
                    client,
                    task_queue=args.task_queue,
                    workflows=[TripWorkflow],
                    activities=ACTIVITIES,
                ):
                    async with asyncio.TaskGroup() as tasks:
                        tasks.create_task(
                            cleanup_loop(
                                DeletionWorker(DeletionService(database), client),
                                stopped,
                            )
                        )
                        tasks.create_task(
                            delivery_loop(
                                FixtureDelivery(
                                    FixtureDispatcher(service, client, args.task_queue)
                                ),
                                stopped,
                            )
                        )
    finally:
        database.close()


def main() -> None:
    args = arguments()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("FIXTURE_RUNTIME_FAILED") from None


if __name__ == "__main__":
    main()
