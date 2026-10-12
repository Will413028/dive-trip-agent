"""PayPal hackathon demo profile: an isolated stack for group deposits.

It runs against its own loopback PostgreSQL (schema `deposits_demo`) and Temporal, uses
synthetic data and the PayPal sandbox only, and never starts the planning agent or any
existing hosted path. PayPal credentials come from the process environment
(PAYPAL_ENV=sandbox, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET); they are never logged.
The settlement agent is optional: GEMINI_API_KEY and/or GROQ_API_KEY enable it (Gemini
first, Groq as fallback, each tried once per request), DEPOSITS_AI_DAILY_CAP bounds live
runs per UTC day (default 50). Without a key every assessment is "No AI".
See docs/adr/2026-10-12-paypal-hackathon-demo-profile.md.
"""

import argparse
import asyncio
import os
import re
import signal
from datetime import datetime, timedelta
from typing import Any

import uvicorn
from google.genai import Client as GoogleClient
from google.genai.types import HttpOptions, HttpRetryOptions
from openai import AsyncOpenAI
from pydantic_ai.models import Model
from pydantic_ai.models.fallback import FallbackModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider
from temporalio.client import Client, WorkflowHandle
from temporalio.service import RPCError
from temporalio.worker import Worker

from dive_trip.application.deposits import (
    DEPOSIT_ACTIVITIES,
    DepositsContext,
    GroupBookingWorkflow,
    bind_deposits,
)
from dive_trip.modules.deposits.assessor import SettlementAgent
from dive_trip.modules.deposits.migrations import migrate_deposits
from dive_trip.modules.deposits.paypal import PayPalClient, SandboxCard
from dive_trip.platform.database import Database, fixture_conninfo
from dive_trip.platform.migrations import migrate

from .deposits_api import create_deposits_app

SCHEMA = "deposits_demo"
# PayPal's published sandbox test Visa; only ever sent to the sandbox API.
SEED_CARD = SandboxCard("4111111111111111", "2030-12", "123", "Demo Diver")


class TemporalWorkflows:
    def __init__(self, client: Client, task_queue: str) -> None:
        self.client, self.task_queue = client, task_queue

    def handle(self, booking_id: str) -> WorkflowHandle[Any, Any]:
        return self.client.get_workflow_handle(f"deposits-{booking_id}")

    async def start(self, booking_id: str, settle_at: datetime) -> None:
        await self.client.start_workflow(
            GroupBookingWorkflow.run,
            args=[booking_id, settle_at.isoformat()],
            id=f"deposits-{booking_id}",
            task_queue=self.task_queue,
            execution_timeout=timedelta(days=60),
        )

    async def check_now(self, booking_id: str) -> None:
        await self.handle(booking_id).signal(GroupBookingWorkflow.check_now)

    async def approve(self, booking_id: str, settlement_id: str) -> None:
        await self.handle(booking_id).signal(
            GroupBookingWorkflow.approve, settlement_id
        )

    async def stop(self, booking_id: str) -> None:
        try:
            await self.handle(booking_id).terminate("workspace reset")
        except RPCError:
            pass  # already finished or never started


def settlement_model() -> Model | None:
    """Free-tier models from the environment; SDK retries are off so each runs once."""
    models: list[Model] = []
    if gemini_key := os.environ.get("GEMINI_API_KEY"):
        client = GoogleClient(
            api_key=gemini_key,
            http_options=HttpOptions(
                timeout=30000, retry_options=HttpRetryOptions(attempts=1)
            ),
        )
        models.append(
            GoogleModel(
                os.environ.get("DEPOSITS_GEMINI_MODEL", "gemini-2.5-flash"),
                provider=GoogleProvider(client=client),
            )
        )
    if groq_key := os.environ.get("GROQ_API_KEY"):
        openai = AsyncOpenAI(
            api_key=groq_key,
            base_url="https://api.groq.com/openai/v1",
            max_retries=0,
            timeout=30,
        )
        models.append(
            OpenAIChatModel(
                os.environ.get("DEPOSITS_GROQ_MODEL", "openai/gpt-oss-120b"),
                provider=OpenAIProvider(openai_client=openai),
            )
        )
    if not models:
        return None
    return models[0] if len(models) == 1 else FallbackModel(*models)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("api", "worker"), required=True)
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument("--temporal-address", default="127.0.0.1:7233")
    parser.add_argument("--task-queue", default="deposits-demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4420)
    parser.add_argument("--origin", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"https?://[a-z0-9.-]+(:[0-9]{1,5})?", args.origin):
        parser.error("INVALID_ORIGIN")
    if os.environ.get("PAYPAL_ENV") != "sandbox":
        parser.error("PAYPAL_SANDBOX_REQUIRED")
    return args


async def run(args: argparse.Namespace) -> None:
    database = Database(fixture_conninfo(args.database_port), SCHEMA)
    database.open()
    paypal = PayPalClient(
        os.environ["PAYPAL_CLIENT_ID"], os.environ["PAYPAL_CLIENT_SECRET"]
    )
    try:
        with database.transaction() as connection:
            connection.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
        migrate(database)
        migrate_deposits(database)
        model = settlement_model() if args.role == "worker" else None
        ctx = DepositsContext(
            database=database,
            paypal=paypal,
            seed_card=SEED_CARD,
            assessor=SettlementAgent(model) if model else None,
            daily_live_cap=int(os.environ.get("DEPOSITS_AI_DAILY_CAP", "50")),
            paypal_client_id=os.environ["PAYPAL_CLIENT_ID"],
        )
        client = await Client.connect(args.temporal_address)
        if args.role == "api":
            app = create_deposits_app(
                database, args.origin, ctx, TemporalWorkflows(client, args.task_queue)
            )
            server = uvicorn.Server(
                uvicorn.Config(app, host=args.host, port=args.port, access_log=False)
            )
            await server.serve()
            return
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, stopped.set)
        bind_deposits(ctx)
        async with Worker(
            client,
            task_queue=args.task_queue,
            workflows=[GroupBookingWorkflow],
            activities=DEPOSIT_ACTIVITIES,
        ):
            await stopped.wait()
    finally:
        await paypal.aclose()
        database.close()


def main() -> None:
    asyncio.run(run(arguments()))


if __name__ == "__main__":
    main()
