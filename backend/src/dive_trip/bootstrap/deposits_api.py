"""Group deposit routes for the PayPal demo profile.

The caller's anonymous session is the workspace: each judge's browser sees only its own
bookings. Money moves only in the workflow or in the explicit join/reset calls, always
through stored money commands.
"""

from collections.abc import Callable
from datetime import UTC, date, datetime, time
from typing import Annotated, Any, Literal, Protocol

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field

from dive_trip.application.deposits import (
    DepositsContext,
    create_booking,
)
from dive_trip.modules.deposits import service
from dive_trip.modules.deposits import transactions as tx
from dive_trip.modules.deposits.domain import CauseRule, Mandate, RefundPolicy
from dive_trip.modules.identity.public import Sessions
from dive_trip.platform.database import Database
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import (
    CalendarDate,
    Nonempty,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)

from .http_boundary import HttpBoundary


class Workflows(Protocol):
    async def start(self, booking_id: str, settle_at: datetime) -> None: ...
    async def check_now(self, booking_id: str) -> None: ...
    async def approve(self, booking_id: str, settlement_id: str) -> None: ...
    async def stop(self, booking_id: str) -> None: ...


class CreateBooking(WireModel):
    title: Annotated[Nonempty, Field(max_length=120)]
    startsOn: CalendarDate
    tripDays: Annotated[PositiveInt, Field(le=14)]
    siteLat: Annotated[float, Field(ge=-90, le=90)]
    siteLon: Annotated[float, Field(ge=-180, le=180)]
    depositMinor: Annotated[PositiveInt, Field(le=500000)]
    rules: Annotated[list[CauseRule], Field(min_length=1, max_length=2)]
    mandate: Mandate
    seedDivers: Annotated[NonnegativeInt, Field(le=4)]


class Join(WireModel):
    name: Annotated[Nonempty, Field(max_length=60)]


class Authorize(WireModel):
    orderId: Annotated[str, Field(pattern=r"^[A-Z0-9]{8,32}$")]


class AddEvidence(WireModel):
    kind: Literal["notice", "alert"]
    body: Annotated[Nonempty, Field(max_length=4000)]


class SimulateStorm(WireModel):
    cancelledDays: Annotated[list[PositiveInt], Field(min_length=1, max_length=14)]


class Decide(WireModel):
    decision: Literal["approve", "reject"]


def agent_view(settlement: dict[str, Any]) -> dict[str, Any] | None:
    """Which agent call backs a settlement; only verified quotes leave the server."""
    if settlement["agent_mode"] is None:
        return None
    result = settlement["agent_result"] or {}
    return {
        "mode": settlement["agent_mode"],  # live, recorded, or capped
        "status": settlement["agent_status"],  # a failed live call fell back to No AI
        "model": settlement["agent_model"],
        "at": settlement["agent_at"].isoformat(),
        "confidence": result.get("confidence"),
        "executionRequested": result.get("executionRequested"),
        "citations": result.get("citations", []),
    }


def view(connection: tx.ConnectionType, row: dict[str, Any]) -> dict[str, Any]:
    booking_id = str(row["id"])
    return {
        "id": booking_id,
        "title": row["title"],
        "startsOn": row["starts_on"].isoformat(),
        "tripDays": row["trip_days"],
        "site": {"lat": float(row["site_lat"]), "lon": float(row["site_lon"])},
        "depositMinor": row["deposit_minor"],
        "policy": row["policy"],
        "mandate": row["mandate"],
        "divers": [
            {
                "id": str(d["id"]),
                "name": d["display_name"],
                "seeded": d["seeded"],
                "state": d["state"],
                "authorizedMinor": d["authorized_minor"],
                "capturedMinor": d["captured_minor"],
                "refundedMinor": d["refunded_minor"],
                "authorizationId": d["authorization_id"],
            }
            for d in tx.divers(connection, booking_id)
        ],
        "evidence": [
            {
                "id": str(e["id"]),
                "kind": e["kind"],
                "body": e["body"],
                "createdAt": e["created_at"].isoformat(),
            }
            for e in tx.evidence(connection, booking_id)
        ],
        "settlements": [
            {
                "id": str(s["id"]),
                "source": s["source"],
                "facts": s["facts"],
                "plan": s["plan"],
                "withinMandate": s["within_mandate"],
                "reasons": s["reasons"],
                "status": s["status"],
                "agent": agent_view(s),
            }
            for s in tx.settlements(connection, booking_id)
        ],
        "timeline": [
            {
                "kind": t["kind"],
                "detail": t["detail"],
                "at": t["created_at"].isoformat(),
            }
            for t in tx.timeline(connection, booking_id)
        ],
    }


def register_deposits(
    app: FastAPI,
    ctx: DepositsContext,
    workflows: Workflows,
    workspace_of: Callable[..., str],
) -> None:
    database = ctx.database
    Workspace = Annotated[str, Depends(workspace_of)]

    def owned(workspace: str, booking_id: str) -> dict[str, Any]:
        with database.transaction() as connection:
            return tx.booking(connection, workspace, booking_id)

    def read(workspace: str, booking_id: str) -> dict[str, Any]:
        with database.transaction() as connection:
            return view(connection, tx.booking(connection, workspace, booking_id))

    @app.get("/api/deposits/bookings")
    def list_bookings(workspace: Workspace) -> list[dict[str, Any]]:
        with database.transaction() as connection:
            return [
                view(connection, tx.booking(connection, workspace, booking_id))
                for booking_id in tx.workspace_bookings(connection, workspace)
            ]

    @app.post("/api/deposits/bookings")
    async def create(body: CreateBooking, workspace: Workspace) -> dict[str, Any]:
        with database.transaction() as connection:
            if len(tx.workspace_bookings(connection, workspace)) >= 5:
                raise DomainError("DEPOSIT_WORKSPACE_FULL")
        starts_on = date.fromisoformat(body.startsOn)
        booking_id = await create_booking(
            ctx,
            workspace=workspace,
            title=body.title,
            starts_on=starts_on,
            site=(body.siteLat, body.siteLon),
            policy=RefundPolicy(
                version=1,
                currency="USD",
                depositMinor=body.depositMinor,
                tripDays=body.tripDays,
                rules=body.rules,
            ),
            mandate=body.mandate,
            seed_divers=body.seedDivers,
        )
        await workflows.start(
            booking_id, datetime.combine(starts_on, time.min, tzinfo=UTC)
        )
        return await run_db(read, workspace, booking_id)

    @app.get("/api/deposits/bookings/{booking_id}")
    def get(booking_id: str, workspace: Workspace) -> dict[str, Any]:
        return read(workspace, booking_id)

    @app.post("/api/deposits/bookings/{booking_id}/join")
    async def join(booking_id: str, body: Join, workspace: Workspace) -> dict[str, Any]:
        owned(workspace, booking_id)
        await service.authorize_diver(
            database, ctx.paypal, booking_id, body.name, ctx.seed_card, seeded=False
        )
        return read(workspace, booking_id)

    @app.get("/api/deposits/config")
    def config() -> dict[str, str | None]:
        return {"paypalClientId": ctx.paypal_client_id}

    @app.post("/api/deposits/bookings/{booking_id}/checkout")
    async def checkout(
        booking_id: str, body: Join, workspace: Workspace
    ) -> dict[str, str]:
        """Start the judge's own deposit: an order they approve in PayPal checkout."""
        owned(workspace, booking_id)
        if ctx.paypal_client_id is None:
            raise DomainError("DEPOSIT_CHECKOUT_DISABLED")
        diver_id, order_id = await service.start_checkout(
            database, ctx.paypal, booking_id, body.name
        )
        return {"diverId": diver_id, "orderId": order_id}

    @app.post("/api/deposits/bookings/{booking_id}/divers/{diver_id}/authorize")
    async def authorize(
        booking_id: str, diver_id: str, body: Authorize, workspace: Workspace
    ) -> dict[str, Any]:
        owned(workspace, booking_id)
        await service.complete_checkout(
            database, ctx.paypal, booking_id, diver_id, body.orderId
        )
        return read(workspace, booking_id)

    @app.post("/api/deposits/bookings/{booking_id}/evidence")
    def add_evidence(
        booking_id: str, body: AddEvidence, workspace: Workspace
    ) -> dict[str, Any]:
        owned(workspace, booking_id)
        with database.transaction() as connection:
            tx.add_evidence(connection, booking_id, body.kind, body.body)
        return read(workspace, booking_id)

    @app.post("/api/deposits/bookings/{booking_id}/simulate-storm")
    def simulate(
        booking_id: str, body: SimulateStorm, workspace: Workspace
    ) -> dict[str, Any]:
        owned(workspace, booking_id)
        days = sorted(set(body.cancelledDays))
        with database.transaction() as connection:
            tx.add_evidence(
                connection,
                booking_id,
                "simulated",
                "SIMULATED storm for the demo: boats cancelled on day(s) "
                + ", ".join(str(day) for day in days),
                {"cancelledDays": days},
            )
        return read(workspace, booking_id)

    @app.post("/api/deposits/bookings/{booking_id}/check")
    async def check(booking_id: str, workspace: Workspace) -> dict[str, bool]:
        owned(workspace, booking_id)
        await workflows.check_now(booking_id)
        return {"requested": True}

    @app.post("/api/deposits/bookings/{booking_id}/settlements/{settlement_id}")
    async def decide(
        booking_id: str, settlement_id: str, body: Decide, workspace: Workspace
    ) -> dict[str, Any]:
        owned(workspace, booking_id)
        decision: Literal["approved", "rejected"] = (
            "approved" if body.decision == "approve" else "rejected"
        )
        with database.transaction() as connection:
            tx.decide_settlement(
                connection, booking_id, settlement_id, decision, "organizer"
            )
        if decision == "approved":
            await workflows.approve(booking_id, settlement_id)
        return read(workspace, booking_id)

    @app.post("/api/deposits/reset")
    async def reset(workspace: Workspace) -> dict[str, int]:
        """Release this workspace's holds, stop its workflows, delete its bookings."""
        with database.transaction() as connection:
            booking_ids = tx.workspace_bookings(connection, workspace)
        for booking_id in booking_ids:
            await workflows.stop(booking_id)
            with database.transaction() as connection:
                held = [
                    tx.record_command(
                        connection,
                        booking_id=booking_id,
                        diver_id=str(d["id"]),
                        kind="void",
                        amount_minor=0,
                    )
                    for d in tx.divers(connection, booking_id)
                    if d["state"] == "authorized"
                ]
            for command in held:
                await service.execute(database, ctx.paypal, str(command["id"]))
            with database.transaction() as connection:
                connection.execute(
                    "DELETE FROM deposit_bookings WHERE id=%s", (booking_id,)
                )
        return {"deleted": len(booking_ids)}


def create_deposits_app(
    database: Database, origin: str, ctx: DepositsContext, workflows: Workflows
) -> FastAPI:
    """The demo profile's whole API: an anonymous session plus deposit routes.

    The planning product (trips, runs, sharing, deletion) is never mounted here.
    """
    app = FastAPI(title="Dive Trip group deposits demo", version="0.1.0")
    app.add_middleware(HttpBoundary, origin=origin)
    sessions = Sessions(database)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse({"error": "INVALID_REQUEST"}, status_code=400)

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, error: DomainError) -> JSONResponse:
        if error.code == "NOT_FOUND":
            return JSONResponse({"error": error.code}, status_code=404)
        if error.code.startswith(
            ("SETTLEMENT_", "MONEY_COMMAND_", "DEPOSIT_", "PAYPAL_")
        ):
            return JSONResponse({"error": error.code}, status_code=409)
        return JSONResponse({"error": "SERVICE_UNAVAILABLE"}, status_code=503)

    @app.exception_handler(Exception)
    async def unavailable(request: Request, error: Exception) -> JSONResponse:
        return JSONResponse({"error": "SERVICE_UNAVAILABLE"}, status_code=503)

    def workspace_of(request: Request, response: Response) -> str:
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

    register_deposits(app, ctx, workflows, workspace_of)
    return app
