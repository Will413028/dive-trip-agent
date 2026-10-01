"""Isolated hosted fixture bootstrap; local/live entry points stay separate."""

import argparse
import asyncio
import json
import os
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
from dive_trip.application.runtime_binding import bind_temporal
from dive_trip.application.workflow import ACTIVITIES, TripWorkflow
from dive_trip.modules.catalog.public import load_catalog
from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.migrations import migrate, require_current

from .api import create_app
from .hosted_config import HostedFixtureConfig
from .hosted_ingress import HostedIngress
from .hosted_storage import (
    HostedIngressStore,
    HostedLimits,
    install_hosted_schema,
    require_hosted_schema,
)
from .runtime import cleanup_loop, delivery_loop

SCHEMA = "workbench_demo"
NAMESPACE = "dive-trip-demo"
QUEUE = "dive-trip-demo"


async def admission_cleanup(store: HostedIngressStore, stopped: asyncio.Event) -> None:
    while not stopped.is_set():
        await run_db(store.prune)
        try:
            await asyncio.wait_for(stopped.wait(), 5)
        except TimeoutError:
            pass


async def run(
    role: str, config: HostedFixtureConfig, limits: HostedLimits = HostedLimits()
) -> None:
    database = Database(config.database_conninfo(), SCHEMA)
    database.open()
    try:
        with database.transaction() as connection:
            target = connection.execute("SELECT current_database() AS name").fetchone()
            if target is None or target["name"] != "dive_trip_demo":
                raise ValueError("HOSTED_DATABASE_TARGET_REQUIRED")
            if role == "migrate":
                connection.execute("CREATE SCHEMA IF NOT EXISTS workbench_demo")
        if role == "migrate":
            migrate(database)
            install_hosted_schema(database, limits)
            return
        if role not in ("api", "worker"):
            raise ValueError("HOSTED_ROLE_INVALID")
        require_current(database)
        require_hosted_schema(database)
        root = Path(__file__).resolve().parents[4]
        catalog = load_catalog(json.loads((root / "data/catalog.json").read_text()))
        service = PlanningService(database, catalog)
        client = await Client.connect(
            "temporal:7233", namespace=NAMESPACE, plugins=[PydanticAIPlugin()]
        )
        await bind_temporal(database, client)
        store = HostedIngressStore(database)
        if role == "api":
            app = create_app(
                database,
                catalog,
                config.origin,
                dispatcher=FixtureDispatcher(service, client, QUEUE),
            )
            guarded = HostedIngress(app, config.ingress_key, store)
            await uvicorn.Server(
                uvicorn.Config(
                    guarded,
                    host="0.0.0.0",
                    port=4320,
                    access_log=False,
                    proxy_headers=False,
                    timeout_graceful_shutdown=20,
                )
            ).serve()
            return
        stopped = asyncio.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(signum, stopped.set)
        with bind_worker_service(service):
            async with Worker(
                client,
                task_queue=QUEUE,
                workflows=[TripWorkflow],
                activities=ACTIVITIES,
            ):
                async with asyncio.TaskGroup() as tasks:
                    tasks.create_task(
                        cleanup_loop(
                            DeletionWorker(DeletionService(database), client), stopped
                        )
                    )
                    tasks.create_task(
                        delivery_loop(
                            FixtureDelivery(FixtureDispatcher(service, client, QUEUE)),
                            stopped,
                        )
                    )
                    tasks.create_task(admission_cleanup(store, stopped))
    finally:
        database.close()


def main() -> None:
    defaults = HostedLimits()
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("migrate", "api", "worker"), required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--database-password-file", type=Path, required=True)
    parser.add_argument("--ingress-key-file", type=Path, required=True)
    parser.add_argument(
        "--global-per-minute", type=int, default=defaults.global_per_minute
    )
    parser.add_argument(
        "--client-per-minute", type=int, default=defaults.client_per_minute
    )
    parser.add_argument("--session-limit", type=int, default=defaults.sessions)
    parser.add_argument("--trip-limit", type=int, default=defaults.trips)
    parser.add_argument("--owner-trip-limit", type=int, default=defaults.owner_trips)
    args = parser.parse_args()
    try:
        config = HostedFixtureConfig.load(
            args.origin, args.database_password_file, args.ingress_key_file, os.environ
        )
        limits = HostedLimits(
            args.global_per_minute,
            args.client_per_minute,
            args.session_limit,
            args.trip_limit,
            args.owner_trip_limit,
        )
        asyncio.run(run(args.role, config, limits))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("HOSTED_FIXTURE_RUNTIME_FAILED") from None


if __name__ == "__main__":
    main()
