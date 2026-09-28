"""Private evaluator composition; never mounted on the product HTTP server.

The caller supplies an owned, isolated database and Temporal client. Authorization,
permanent campaign claims and historical inventory remain in the outer controller.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from uuid import uuid4

import httpx2 as httpx
from temporalio.client import Client

from dive_trip.application.admission import AdmissionService
from dive_trip.application.evaluation_capture import campaign_inventory
from dive_trip.application.evaluation_runtime import (
    EvaluationDispatcher,
    OwnedGeneration,
)
from dive_trip.application.planning import PlanningService
from dive_trip.application.run_queries import RunQueries
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.trips import TripService
from dive_trip.application.usage_audit import UsageAudit
from dive_trip.application.usage_evidence import UsageEvidence, read_usage_evidence
from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.identity.public import Sessions
from dive_trip.modules.trips.public import Snapshot
from dive_trip.modules.trips.transactions import TripView
from dive_trip.modules.usage.public import Policy, ProviderBinding
from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer
from dive_trip.platform.schema import WireModel

from .api import create_app

ORIGIN = "http://localhost"


class EvaluationSetup(WireModel):
    before: Snapshot
    catalog: list[CatalogItem]
    fault: Literal["catalog-timeout"] | None = None


class EvaluationResponse(WireModel):
    status: int
    contentType: str
    body: str


class EvaluationSession:
    def __init__(
        self,
        database: Database,
        temporal: Client,
        provider: ProviderBinding,
        policy: Policy,
        peer: EvaluationLoopbackPeer,
        load_generation: Callable[[], Awaitable[OwnedGeneration]],
    ) -> None:
        if re.fullmatch(r"python_test_[a-f0-9]{32}", database.schema) is None:
            raise DomainError("EVALUATION_CONTEXT_REQUIRED")
        self.database, self.temporal = database, temporal
        self.provider, self.policy, self.peer = provider, policy, peer
        self.load_generation = load_generation
        self.dispatcher: EvaluationDispatcher | None = None
        self.client: httpx.AsyncClient | None = None
        self.owner: str | None = None
        self.trip: TripView | None = None
        self.lock = asyncio.Lock()
        self.owned_trips: set[str] = set()
        self.evidence: dict[str, UsageEvidence] = {}
        self.captured = True
        self.last_fingerprint: str | None = None

    async def setup(self, input: EvaluationSetup) -> TripView:
        async with self.lock:
            if not self.captured:
                raise DomainError("EVALUATION_CAPTURE_REQUIRED")
            await self.close()
            self.captured = False
            self.last_fingerprint = None
            self.owner, self.trip, self.dispatcher = None, None, None
            # Each case has a fresh owner and trip; quota remains campaign-wide.
            owner, token = await run_db(Sessions(self.database).create)
            trip = await run_db(
                TripService(self.database).create, owner, input.before.model_dump()
            )
            self.owned_trips.add(trip.id)
            service = PlanningService(
                self.database,
                input.catalog,
                accounting=RuntimeAccounting(self.provider),
            )
            dispatcher = EvaluationDispatcher(
                service,
                AdmissionService(
                    self.database, input.catalog, evaluation_fault=input.fault
                ),
                self.temporal,
                f"dive-evaluation-{uuid4().hex}",
                policy=self.policy,
                peer=self.peer,
                load_generation=self.load_generation,
            )
            app = create_app(
                self.database, input.catalog, ORIGIN, dispatcher=dispatcher
            )
            self.client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app, client=("127.0.0.1", 0)),
                base_url=ORIGIN,
                headers={"Origin": ORIGIN},
                cookies={"dive_trip_session": token},
                trust_env=False,
                follow_redirects=False,
            )
            self.owner, self.trip, self.dispatcher = owner, trip, dispatcher
            self.captured = False
            return trip

    async def request(self, path: str, body: Any) -> EvaluationResponse:
        async with self.lock:
            if self.client is None or self.trip is None:
                raise DomainError("EVALUATION_SETUP_REQUIRED")
            prefix = f"/api/trips/{self.trip.id}"
            # The collector needs only these product routes. No URL, arbitrary
            # header, identity, generation config or administrative route enters.
            if not (
                body is None and path in (prefix, f"{prefix}/runs")
                or body is not None and path == f"{prefix}/agent"
            ):
                raise DomainError("EVALUATION_ROUTE_DISABLED")
            if body is not None:
                self.captured = False
            async with asyncio.timeout(60):
                response = await self.client.request(
                    "GET" if body is None else "POST", path, json=body
                )
            if len(response.content) > 1048576:
                raise DomainError("EVALUATION_RESPONSE_TOO_LARGE")
            return EvaluationResponse(
                status=response.status_code,
                contentType=response.headers.get("content-type", ""),
                body=response.text,
            )

    async def audit(self, run_id: str) -> UsageAudit:
        async with self.lock:
            if self.dispatcher is None or self.owner is None or self.trip is None:
                raise DomainError("EVALUATION_SETUP_REQUIRED")
            binding = await run_db(
                RunQueries(self.database).binding, self.owner, self.trip.id, run_id
            )
            _, _, audit = await self.dispatcher.capture(binding)
            return audit

    async def capture(self) -> dict[str, Any]:
        async with self.lock:
            self.captured = False
            if self.dispatcher is None or self.owner is None or self.trip is None:
                raise DomainError("EVALUATION_SETUP_REQUIRED")
            await self.dispatcher.join()
            runs = await run_db(
                RunQueries(self.database).list, self.owner, self.trip.id
            )
            private_usage, native_history = [], []
            complete = True
            known = len(runs) == 1
            for run in runs:
                binding = await run_db(
                    RunQueries(self.database).binding,
                    self.owner,
                    self.trip.id,
                    run["id"],
                )
                usage = await run_db(
                    read_usage_evidence, self.database, binding, self.provider
                )
                self.evidence[run["id"]] = usage
                private_usage.append(usage.model_dump(mode="json"))
                try:
                    checked, native, audit = await self.dispatcher.capture(binding)
                    if checked != usage:
                        raise DomainError("EVALUATION_EVIDENCE_CHANGED")
                    native_history.append(native.model_dump(mode="json"))
                    known = known and audit.complete
                except DomainError:
                    # Keep the DB evidence in the report; a failed native audit
                    # cannot become successful drain/evidence or authorize cleanup.
                    complete, known = False, False
            inventory = await run_db(
                campaign_inventory,
                self.database,
                self.owned_trips,
                self.evidence,
                self.trip.id,
            )
            known = known and all(
                row.status == "settled" and row.actual_cost_micros is not None
                for saved in self.evidence.values()
                for row in saved.invocations
            )
            tokens = sum(
                call.event.usage.totalTokens
                for saved in self.evidence.values()
                for call in saved.calls
                if call.event.usage is not None
            )
            self.captured = complete and known and all(
                run["status"] in ("succeeded", "failed", "interrupted") for run in runs
            )
            if self.captured:
                self.last_fingerprint = inventory["storageFingerprint"]
            return {
                "chargedMicros": inventory["chargedMicros"],
                "modelCalls": inventory["modelCalls"],
                "totalTokens": tokens if known else None,
                "usageKnown": known,
                "privateUsageComplete": complete,
                "record": {
                    **inventory,
                    "schemaVersion": 3,
                    "executor": "temporal-v1",
                    "privateUsage": private_usage,
                    "nativeHistory": native_history,
                    "privateUsageComplete": complete,
                    "quiescent": True,
                },
            }

    def cleanup_fingerprint(self) -> str:
        if not self.captured or self.last_fingerprint is None:
            raise DomainError("EVALUATION_CAPTURE_REQUIRED")
        return self.last_fingerprint

    async def close(self) -> None:
        # Joining a closed logical history is insufficient: wait for the actual
        # owned worker and SDK before replacing the session or releasing storage.
        if self.dispatcher is not None:
            await self.dispatcher.join()
        if self.client is not None:
            await self.client.aclose()
            self.client = None
