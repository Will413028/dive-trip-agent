"""Conservative quota ledger with a single serial admission gate."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from psycopg import Connection
from pydantic import AwareDatetime, Field, model_validator

from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import (
    Nonempty,
    NonnegativeInt,
    PositiveInt,
    WireModel,
    safe_integer,
)

TAIPEI = ZoneInfo("Asia/Taipei")
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class Policy(WireModel):
    enabled: bool
    dailyBudgetMicros: PositiveInt
    priceBasis: Literal["synthetic", "server-verified"]
    reservationTtlMs: Annotated[PositiveInt, Field(le=300000)]


class Reserve(WireModel):
    ownerId: str
    ipKey: Digest
    previousIpKey: Digest | None = None
    requestId: Annotated[Nonempty, Field(max_length=128)]
    payloadHash: Digest
    logicalRunId: str | None = None
    maxCostMicros: NonnegativeInt
    now: AwareDatetime

    @model_validator(mode="after")
    def identities(self) -> "Reserve":
        UUID(self.ownerId)
        if self.logicalRunId is not None:
            UUID(self.logicalRunId)
        if "\0" in self.requestId:
            raise ValueError("invalid request ID")
        return self


class Reservation(WireModel):
    reservationId: str
    ownerId: str
    day: str
    status: Literal["reserved", "expired", "settled"]
    maxCostMicros: NonnegativeInt
    chargedCostMicros: NonnegativeInt
    actualCostMicros: NonnegativeInt | None
    expiresAt: AwareDatetime


def reservation_view(row: dict[str, Any]) -> Reservation:
    return Reservation(
        reservationId=str(row["id"]),
        ownerId=str(row["owner_id"]),
        day=str(row["day"]),
        status=row["status"],
        maxCostMicros=row["max_cost_micros"],
        chargedCostMicros=row["charged_cost_micros"],
        actualCostMicros=row["actual_cost_micros"],
        expiresAt=row["expires_at"],
    )


def lock_global(connection: Connection[dict[str, Any]]) -> None:
    if (
        connection.execute(
            "SELECT id FROM quota_global_lock WHERE id=1 FOR UPDATE"
        ).fetchone()
        is None
    ):
        raise DomainError("QUOTA_UNAVAILABLE")


def require_fixture_binding(
    connection: Connection[dict[str, Any]], run_id: str
) -> None:
    if connection.execute(
        "SELECT id FROM agent_invocations WHERE run_id=%s", (run_id,)
    ).fetchone():
        raise DomainError("PROVIDER_CONFLICT")


@dataclass
class AdmissionClock:
    now: datetime
    started: float
    monotonic: Callable[[], float] = time.monotonic

    def effective(self) -> datetime:
        return self.now + timedelta(seconds=self.monotonic() - self.started)

    def check(self, expires: datetime) -> datetime:
        now = self.effective()
        if now >= expires:
            raise DomainError("QUOTA_RESERVATION_EXPIRED")
        if now.astimezone(TAIPEI).date() != self.now.astimezone(TAIPEI).date():
            raise DomainError("QUOTA_CLOCK_CHANGED")
        return now


def reserve_in_transaction(
    connection: Connection[dict[str, Any]],
    input: Reserve,
    policy: Policy,
    clock: AdmissionClock,
) -> tuple[Reservation, bool]:
    lock_global(connection)
    previous = connection.execute(
        """
        SELECT * FROM quota_reservations WHERE owner_id=%s AND request_id=%s
        """,
        (input.ownerId, input.requestId),
    ).fetchone()
    expires = input.now + timedelta(milliseconds=policy.reservationTtlMs)
    if previous is None and policy.enabled:
        clock.check(expires)
    if previous is not None:
        logical = (
            str(previous["logical_run_id"]) if previous["logical_run_id"] else None
        )
        if (
            previous["payload_hash"] != input.payloadHash
            or previous["max_cost_micros"] != input.maxCostMicros
            or logical != input.logicalRunId
        ):
            raise DomainError("IDEMPOTENCY_CONFLICT")
        if (
            previous["status"] == "reserved"
            and previous["expires_at"] <= clock.effective()
        ):
            connection.execute(
                "UPDATE quota_reservations SET status='expired' WHERE id=%s",
                (previous["id"],),
            )
            previous["status"] = "expired"
        return reservation_view(previous), False
    if not policy.enabled:
        raise DomainError("LIVE_DISABLED")
    checked = clock.check(expires)
    day = input.now.astimezone(TAIPEI).date()
    keys = [input.ipKey] + ([input.previousIpKey] if input.previousIpKey else [])
    usage = connection.execute(
        """
        SELECT count(*) FILTER
          (WHERE status='reserved' AND expires_at>%(now)s) AS active,
        COALESCE(sum(charged_cost_micros) FILTER (WHERE day=%(day)s),0)
          + COALESCE((SELECT charged_cost_micros FROM quota_daily_totals
                      WHERE day=%(day)s),0) AS charged,
        count(*) FILTER (WHERE ip_key=ANY(%(keys)s::text[])
          AND reserved_at>%(now)s::timestamptz-interval '1 minute') AS ip_minute,
        count(*) FILTER (WHERE ip_key=%(ip)s AND day=%(day)s) AS ip_day,
        count(DISTINCT COALESCE(logical_run_id,id))
          FILTER (WHERE owner_id=%(owner)s AND day=%(day)s) AS session_day,
        COALESCE(bool_or(logical_run_id=%(run)s::uuid
          AND owner_id=%(owner)s AND day=%(day)s),false)
          AS logical_seen FROM quota_reservations
        """,
        {
            "now": checked,
            "day": day,
            "keys": keys,
            "ip": input.ipKey,
            "owner": input.ownerId,
            "run": input.logicalRunId,
        },
    ).fetchone()
    assert usage is not None
    if (
        input.maxCostMicros > 0
        and usage["charged"] + input.maxCostMicros > policy.dailyBudgetMicros
    ):
        raise DomainError("QUOTA_BUDGET")
    for field, limit, code in (
        ("active", 3, "QUOTA_CONCURRENCY"),
        ("ip_minute", 5, "QUOTA_IP_MINUTE"),
        ("ip_day", 100, "QUOTA_IP_DAY"),
    ):
        if usage[field] >= limit:
            raise DomainError(code)
    if usage["session_day"] >= 20 and not usage["logical_seen"]:
        raise DomainError("QUOTA_SESSION_DAY")
    row = connection.execute(
        """
        INSERT INTO quota_reservations(id,owner_id,ip_key,request_id,payload_hash,day,
        reserved_at,expires_at,max_cost_micros,charged_cost_micros,status,logical_run_id)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'reserved',%s) RETURNING *
        """,
        (
            uuid4(),
            input.ownerId,
            input.ipKey,
            input.requestId,
            input.payloadHash,
            day,
            clock.check(expires),
            expires,
            input.maxCostMicros,
            input.maxCostMicros,
            input.logicalRunId,
        ),
    ).fetchone()
    assert row is not None
    return reservation_view(row), True


def settle_in_transaction(
    connection: Connection[dict[str, Any]],
    reservation_id: str,
    actual: int | None,
    now: datetime,
) -> Reservation:
    UUID(reservation_id)
    actual = safe_integer(actual) if actual is not None else None
    if now.tzinfo is None or (actual is not None and actual < 0):
        raise ValueError("INVALID_QUOTA_INPUT")
    lock_global(connection)
    row = connection.execute(
        "SELECT * FROM quota_reservations WHERE id=%s FOR UPDATE", (reservation_id,)
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    if now < row["reserved_at"]:
        raise DomainError("INVALID_QUOTA_INPUT")
    if row["status"] == "settled":
        if row["actual_cost_micros"] != actual:
            raise DomainError("IDEMPOTENCY_CONFLICT")
        return reservation_view(row)
    saved = connection.execute(
        """
        UPDATE quota_reservations SET status='settled',settled_at=%s,
        actual_cost_micros=%s,charged_cost_micros=COALESCE(%s::bigint,max_cost_micros)
        WHERE id=%s RETURNING *
        """,
        (now, actual, actual, reservation_id),
    ).fetchone()
    assert saved is not None
    return reservation_view(saved)
