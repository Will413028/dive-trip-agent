"""FastAPI composition. Services are explicitly supplied; imports never open a DB."""

from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import Field

from dive_trip.application.deletion import DeletionService
from dive_trip.application.demo import DemoScenario, demo_snapshot
from dive_trip.application.dispatch import AgentDispatcher
from dive_trip.application.run_queries import RunQueries
from dive_trip.application.sharing import SharingService
from dive_trip.application.trips import TripService
from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.identity.public import Sessions
from dive_trip.modules.planning.answer_contract import Version
from dive_trip.modules.sharing.public import PublicTrip
from dive_trip.modules.trips.public import Requirements, Snapshot
from dive_trip.modules.trips.transactions import TripView
from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import Nonempty, WireModel

from .chat import (
    ResumeProps,
    RunInput,
    StartProps,
    encode_event,
    observe,
    start_while_connected,
)
from .http_boundary import HttpBoundary


class Empty(WireModel):
    pass


class CreateTrip(WireModel):
    requirements: Requirements


class CreateDemo(WireModel):
    scenario: DemoScenario


class Propose(WireModel):
    baseVersion: Version
    changes: Annotated[list[Any], Field(max_length=100)]


class Apply(WireModel):
    baseVersion: Version
    proposalId: str
    requestId: Annotated[Nonempty, Field(max_length=128)]


class Restore(WireModel):
    baseVersion: Version
    targetVersion: Version
    requestId: Annotated[Nonempty, Field(max_length=128)]


class SharePreview(WireModel):
    version: Version


class ShareCreate(SharePreview):
    previewHash: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


def create_app(
    database: Database,
    catalog: list[CatalogItem],
    origin: str,
    *,
    dispatcher: AgentDispatcher | None = None,
) -> FastAPI:
    app = FastAPI(title="Dive Trip API", version="0.1.0")
    app.add_middleware(HttpBoundary, origin=origin)
    sessions, trips = Sessions(database), TripService(database)
    queries = RunQueries(database)
    sharing = SharingService(database, catalog)
    deletions = DeletionService(database)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse({"error": "INVALID_REQUEST"}, status_code=400)

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, error: DomainError) -> JSONResponse:
        status = (
            404
            if error.code == "NOT_FOUND"
            else 409
            if error.code
            in (
                "STALE_VERSION",
                "IDEMPOTENCY_CONFLICT",
                "RUN_ACTIVE",
                "RUN_STATE_CONFLICT",
                "SHARE_PREVIEW_CHANGED",
                "LEGACY_HISTORY_READ_ONLY",
            )
            else 400
            if error.code in ("INVALID_PROPOSAL", "INVALID_SNAPSHOT", "INVALID_RUN")
            else 503
        )
        return JSONResponse(
            {"error": error.code if status != 503 else "SERVICE_UNAVAILABLE"},
            status_code=status,
        )

    @app.exception_handler(Exception)
    async def unavailable(request: Request, error: Exception) -> JSONResponse:
        return JSONResponse({"error": "SERVICE_UNAVAILABLE"}, status_code=503)

    def require_owner(request: Request) -> str:
        owner = sessions.resolve(";".join(request.headers.getlist("cookie")))
        if owner is None:
            raise DomainError("NOT_FOUND")
        return owner

    def ensure_session(request: Request, response: Response) -> str:
        owner = sessions.resolve(";".join(request.headers.getlist("cookie")))
        if owner is None:
            owner, token = sessions.create()
            response.set_cookie(
                "dive_trip_session",
                token,
                max_age=2592000,
                httponly=True,
                secure=origin.startswith("https:"),
                samesite="lax",
                path="/",
            )
        return owner

    @app.get("/api/trips/{trip_id}/runs")
    def runs(trip_id: str, owner: str = Depends(require_owner)) -> dict[str, Any]:
        return {"runs": queries.list(owner, trip_id)}

    @app.get("/api/trips/{trip_id}/runs/{run_id}/events")
    def replay(
        trip_id: str, run_id: str, owner: str = Depends(require_owner)
    ) -> Response:
        run = queries.get(owner, trip_id, run_id)
        if run["answerContractVersion"] != 1:
            raise DomainError("RUN_STATE_CONFLICT")
        return Response(
            "".join(encode_event(item) for item in run["events"]),
            media_type="text/event-stream",
        )

    @app.post("/api/trips/{trip_id}/agent")
    async def agent(
        trip_id: str,
        body: RunInput,
        request: Request,
        owner: str = Depends(require_owner),
    ) -> Response:
        if body.threadId != trip_id:
            raise DomainError("INVALID_RUN")
        if dispatcher is None:
            raise DomainError("AGENT_POLICY_DISABLED")
        if isinstance(body.forwardedProps, ResumeProps):
            binding = await run_db(
                queries.binding, owner, trip_id, body.forwardedProps.runId
            )
            answer = body.resume[0]
            await dispatcher.decide(
                binding,
                answer.interruptId,
                answer.payload.confirmed,
                event_request_id=body.runId,
            )
        else:
            assert isinstance(body.forwardedProps, StartProps)
            base_version = body.forwardedProps.baseVersion
            binding = await start_while_connected(
                request,
                dispatcher,
                lambda: dispatcher.start(
                    owner,
                    trip_id,
                    body.runId,
                    body.messages[0].content.strip(),
                    base_version,
                ),
            )
        return StreamingResponse(
            observe(queries, dispatcher, binding, resume=bool(body.resume)),
            media_type="text/event-stream",
        )

    @app.post("/api/session")
    def session(body: Empty, request: Request, response: Response) -> dict[str, bool]:
        ensure_session(request, response)
        return {"ok": True}

    @app.post("/api/demo")
    def demo(body: CreateDemo, request: Request, response: Response) -> TripView:
        return trips.create(
            ensure_session(request, response), demo_snapshot(catalog, body.scenario)
        )

    @app.get("/api/catalog")
    def get_catalog() -> list[CatalogItem]:
        return catalog

    @app.get("/api/agent-mode")
    def agent_mode() -> dict[str, str]:
        return {"mode": "fixture"}

    @app.get("/api/shares/{token}")
    def read_share(token: str, response: Response) -> PublicTrip:
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        return sharing.read(token)

    @app.post("/api/trips/{trip_id}/shares/preview")
    def preview_share(
        trip_id: str, body: SharePreview, owner: str = Depends(require_owner)
    ) -> dict[str, Any]:
        return sharing.preview(owner, trip_id, body.version)

    @app.post("/api/trips/{trip_id}/shares")
    def create_share(
        trip_id: str, body: ShareCreate, owner: str = Depends(require_owner)
    ) -> dict[str, Any]:
        return sharing.create(owner, trip_id, body.version, body.previewHash)

    @app.get("/api/trips/{trip_id}/shares")
    def list_shares(
        trip_id: str, owner: str = Depends(require_owner)
    ) -> dict[str, Any]:
        return {"shares": sharing.list(owner, trip_id)}

    @app.post("/api/trips/{trip_id}/shares/{share_id}/revoke")
    def revoke_share(
        trip_id: str, share_id: str, body: Empty, owner: str = Depends(require_owner)
    ) -> dict[str, bool]:
        sharing.revoke(owner, trip_id, share_id)
        return {"ok": True}

    @app.post("/api/trips")
    def create_trip(body: CreateTrip, owner: str = Depends(require_owner)) -> TripView:
        return trips.create(
            owner,
            Snapshot(
                requirements=body.requirements,
                entries=[],
                exclusions=["往返交通、餐費與裝備費未納入"],
            ),
        )

    @app.get("/api/trips/{trip_id}")
    def get_trip(trip_id: str, owner: str = Depends(require_owner)) -> TripView:
        return trips.get(owner, trip_id)

    @app.delete("/api/trips/{trip_id}", status_code=202)
    def delete_trip(
        trip_id: str,
        body: Empty,
        response: Response,
        owner: str = Depends(require_owner),
    ) -> dict[str, Any]:
        result = deletions.request(owner, trip_id)
        if result["status"] == "deleted":
            response.status_code = 200
        return result

    @app.get("/api/trips/{trip_id}/deletion")
    def deletion_status(
        trip_id: str, owner: str = Depends(require_owner)
    ) -> dict[str, Any]:
        return deletions.status(owner, trip_id)

    @app.post("/api/trips/{trip_id}/proposals")
    def propose(
        trip_id: str, body: Propose, owner: str = Depends(require_owner)
    ) -> dict[str, Any]:
        identity, draft = trips.propose(
            owner, trip_id, body.baseVersion, body.changes, catalog
        )
        value = draft.model_dump(mode="json")
        for issue in value["issues"]:
            if issue["entryId"] is None:
                del issue["entryId"]
        saved = trips.proposal(owner, trip_id, identity)
        return {"proposalId": identity, "draft": value, "review": saved["review"]}

    @app.post("/api/trips/{trip_id}/apply")
    def apply(
        trip_id: str, body: Apply, owner: str = Depends(require_owner)
    ) -> TripView:
        return trips.mutate(
            owner, trip_id, body.baseVersion, body.requestId, "apply", body.proposalId
        )

    @app.post("/api/trips/{trip_id}/restore")
    def restore(
        trip_id: str, body: Restore, owner: str = Depends(require_owner)
    ) -> TripView:
        return trips.mutate(
            owner,
            trip_id,
            body.baseVersion,
            body.requestId,
            "restore",
            body.targetVersion,
        )

    @app.post("/api/trips/{trip_id}/proposals/{proposal_id}/reject")
    def reject(
        trip_id: str, proposal_id: str, body: Empty, owner: str = Depends(require_owner)
    ) -> dict[str, bool]:
        trips.reject(owner, trip_id, proposal_id)
        return {"ok": True}

    return app
