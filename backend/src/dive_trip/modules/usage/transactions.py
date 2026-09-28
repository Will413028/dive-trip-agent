"""Private accounting operations under the application's admission transaction."""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.platform.errors import DomainError

from .provider import ModelUsageEvent, ProviderBinding, validate_usage
from .quota import Reservation, settle_in_transaction

ConnectionType = Connection[dict[str, Any]]


def compact_receipts(connection: Connection[dict[str, Any]]) -> int:
    """Caller owns the global gate; unknown charges survive identifier removal."""
    row = connection.execute(
        "WITH removed AS (DELETE FROM quota_reservations WHERE id IN ("
        "SELECT q.id FROM quota_reservations q WHERE "
        "q.reserved_at<=clock_timestamp()-interval '30 days' "
        "AND q.expires_at<=clock_timestamp() "
        "AND q.day<(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date "
        "AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=q.owner_id "
        "AND s.expires_at>clock_timestamp()) "
        "AND NOT EXISTS(SELECT 1 FROM agent_invocations i WHERE i.reservation_id=q.id) "
        "ORDER BY q.reserved_at,q.id LIMIT 1000) "
        "RETURNING day,charged_cost_micros,actual_cost_micros), "
        "totals AS (INSERT INTO quota_daily_totals "
        "(day,reservations,charged_cost_micros,unknown_usage) "
        "SELECT day,count(*),sum(charged_cost_micros),"
        "count(*) FILTER(WHERE actual_cost_micros IS NULL) FROM removed GROUP BY day "
        "ON CONFLICT(day) DO UPDATE SET "
        "reservations=quota_daily_totals.reservations+EXCLUDED.reservations,"
        "charged_cost_micros=quota_daily_totals.charged_cost_micros+EXCLUDED.charged_cost_micros,"
        "unknown_usage=quota_daily_totals.unknown_usage+EXCLUDED.unknown_usage "
        "RETURNING day) SELECT count(*) AS removed FROM removed"
    ).fetchone()
    assert row is not None
    # Old empty locking buckets carry identifiers, but no cost or usage.
    connection.execute(
        "DELETE FROM quota_session_days b WHERE NOT EXISTS(SELECT 1 FROM "
        "quota_reservations q WHERE q.owner_id=b.owner_id AND q.day=b.day)"
    )
    connection.execute(
        "DELETE FROM quota_ips b WHERE NOT EXISTS(SELECT 1 FROM "
        "quota_reservations q WHERE q.ip_key=b.ip_key)"
    )
    connection.execute(
        "DELETE FROM quota_days b WHERE NOT EXISTS(SELECT 1 FROM "
        "quota_reservations q WHERE q.day=b.day)"
    )
    connection.execute(
        "DELETE FROM quota_daily_totals WHERE "
        "day<(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date-90"
    )
    return int(row["removed"])


def binding_of(row: dict[str, Any]) -> ProviderBinding:
    try:
        return ProviderBinding(
            provider=row["provider"], model=row["model"], accountId=row["account_id"]
        )
    except ValueError as error:
        raise DomainError("PROVIDER_CONFLICT") from error


def require_binding(
    connection: ConnectionType, run_id: str, binding: ProviderBinding
) -> None:
    rows = connection.execute(
        "SELECT * FROM agent_invocations WHERE run_id=%s", (run_id,)
    ).fetchall()
    if not rows or any(binding_of(row) != binding for row in rows):
        raise DomainError("PROVIDER_CONFLICT")


def bound_provider(connection: ConnectionType, run_id: str) -> ProviderBinding | None:
    rows = connection.execute(
        "SELECT * FROM agent_invocations WHERE run_id=%s", (run_id,)
    ).fetchall()
    if not rows:
        return None
    provider = binding_of(rows[0])
    if any(binding_of(row) != provider for row in rows):
        raise DomainError("PROVIDER_CONFLICT")
    return provider


def reservation_invocation(
    connection: ConnectionType, reservation_id: str
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM agent_invocations WHERE reservation_id=%s", (reservation_id,)
    ).fetchone()
    if row is None:
        raise DomainError("ADMISSION_STATE_CONFLICT")
    return row


def start_invocation(connection: ConnectionType, run_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM agent_invocations WHERE run_id=%s AND kind='start' FOR UPDATE",
        (run_id,),
    ).fetchone()
    if row is None:
        raise DomainError("ADMISSION_STATE_CONFLICT")
    return row


def invocation(
    connection: ConnectionType, run_id: str, invocation_id: str
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM agent_invocations WHERE id=%s AND run_id=%s FOR UPDATE",
        (invocation_id, run_id),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    binding_of(row)
    return row


def create_invocation(
    connection: ConnectionType,
    run_id: str,
    reservation_id: str,
    kind: str,
    binding: ProviderBinding,
    max_cost: int,
    expires: datetime,
) -> dict[str, Any]:
    if kind not in ("start", "resume") or (
        max_cost <= 0 if kind == "start" else max_cost != 0
    ):
        raise DomainError("INVALID_ADMISSION")
    connection.execute(
        "UPDATE agent_invocations SET status='expired' WHERE run_id=%s "
        "AND status='active' AND expires_at<=clock_timestamp()",
        (run_id,),
    )
    if connection.execute(
        "SELECT id FROM agent_invocations WHERE run_id=%s AND status='active'",
        (run_id,),
    ).fetchone():
        raise DomainError("ADMISSION_ACTIVE")
    prior = connection.execute(
        "SELECT count(*) AS n FROM model_calls WHERE run_id=%s", (run_id,)
    ).fetchone()
    assert prior is not None
    if prior["n"] >= 7 if kind == "start" else prior["n"] > 7:
        raise DomainError("MODEL_CALL_LIMIT")
    row = connection.execute(
        """INSERT INTO agent_invocations
        (id,run_id,reservation_id,kind,provider,model,account_id,max_cost_micros,
         status,prior_model_calls,expires_at)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'active',%s,%s) RETURNING *""",
        (
            str(uuid4()),
            run_id,
            reservation_id,
            kind,
            binding.provider,
            binding.model,
            binding.accountId,
            max_cost,
            prior["n"],
            expires,
        ),
    ).fetchone()
    assert row is not None
    return row


def require_active(
    connection: ConnectionType, row: dict[str, Any], owner_id: str
) -> None:
    # Application has already fenced the owner, trip, and running run lease.
    live = connection.execute(
        """SELECT i.id FROM agent_invocations i
        JOIN quota_reservations q ON q.id=i.reservation_id
        WHERE i.id=%s AND i.status='active' AND i.expires_at>clock_timestamp()
        AND q.status='reserved' AND q.expires_at>clock_timestamp()
        AND q.owner_id=%s AND q.logical_run_id=i.run_id""",
        (row["id"], owner_id),
    ).fetchone()
    if live is None:
        raise DomainError("ADMISSION_NOT_ACTIVE")


def record_start(connection: ConnectionType, row: dict[str, Any], call_id: str) -> bool:
    if (
        not isinstance(call_id, str)
        or not 1 <= len(call_id) <= 128
        or not call_id.strip()
        or "\0" in call_id
    ):
        raise DomainError("INVALID_MODEL_USAGE")
    if row["max_cost_micros"] == 0:
        raise DomainError("MODEL_GENERATION_DISABLED")
    previous = connection.execute(
        "SELECT invocation_id FROM model_calls WHERE run_id=%s AND call_id=%s",
        (row["run_id"], call_id),
    ).fetchone()
    if previous is not None:
        if previous["invocation_id"] != row["id"]:
            raise DomainError("IDEMPOTENCY_CONFLICT")
        return False
    count = connection.execute(
        "SELECT count(*) AS n FROM model_calls WHERE run_id=%s", (row["run_id"],)
    ).fetchone()
    assert count is not None
    if count["n"] >= 7:
        raise DomainError("MODEL_CALL_LIMIT")
    connection.execute(
        "INSERT INTO model_calls(invocation_id,run_id,call_id,status) "
        "VALUES(%s,%s,%s,'started')",
        (row["id"], row["run_id"], call_id),
    )
    return True


def record_usage(
    connection: ConnectionType, row: dict[str, Any], event: ModelUsageEvent
) -> bool:
    if row["max_cost_micros"] == 0:
        raise DomainError("MODEL_GENERATION_DISABLED")
    try:
        validate_usage(binding_of(row), event)
    except ValueError as error:
        raise DomainError("INVALID_MODEL_USAGE") from error
    previous = connection.execute(
        "SELECT * FROM model_calls WHERE run_id=%s AND call_id=%s",
        (row["run_id"], event.callId),
    ).fetchone()
    if previous is None:
        raise DomainError("MODEL_CALL_NOT_STARTED")
    if previous["invocation_id"] != row["id"]:
        raise DomainError("IDEMPOTENCY_CONFLICT")
    usage = (
        event.usage.model_dump(exclude_none=True) if event.usage is not None else None
    )
    evidence = (
        event.providerEvidence.model_dump()
        if event.providerEvidence is not None
        else None
    )
    if previous["status"] == "completed":
        if previous["usage"] != usage or previous["provider_evidence"] != evidence:
            raise DomainError("IDEMPOTENCY_CONFLICT")
        return False
    connection.execute(
        "UPDATE model_calls SET status='completed',usage=%s,provider_evidence=%s,"
        "completed_at=clock_timestamp() WHERE invocation_id=%s AND call_id=%s",
        (
            Jsonb(usage) if usage is not None else None,
            Jsonb(evidence) if evidence is not None else None,
            row["id"],
            event.callId,
        ),
    )
    return True


def usage_events(
    connection: ConnectionType, row: dict[str, Any]
) -> tuple[list[ModelUsageEvent], bool]:
    calls = connection.execute(
        "SELECT * FROM model_calls WHERE invocation_id=%s ORDER BY started_at,call_id",
        (row["id"],),
    ).fetchall()
    events = []
    known = True
    for call in calls:
        if call["run_id"] != row["run_id"] or call["status"] != "completed":
            known = False
            continue
        try:
            event = ModelUsageEvent(
                kind="model-call-usage",
                callId=call["call_id"],
                usage=call["usage"],
                providerEvidence=call["provider_evidence"],
            )
            validate_usage(binding_of(row), event)
            known = known and event.usage is not None
            events.append(event)
        except ValueError:
            known = False
    return events, known


def erase_runs(connection: ConnectionType, owner_id: str, run_ids: list[str]) -> None:
    rows = connection.execute(
        "SELECT * FROM agent_invocations WHERE run_id=ANY(%s::uuid[]) FOR UPDATE",
        (run_ids,),
    ).fetchall()
    for row in rows:
        if row["status"] != "settled":
            settle_invocation(connection, row, owner_id, None, datetime.now(UTC))
    connection.execute(
        "DELETE FROM model_calls WHERE run_id=ANY(%s::uuid[])", (run_ids,)
    )
    connection.execute(
        "DELETE FROM agent_invocations WHERE run_id=ANY(%s::uuid[])", (run_ids,)
    )


def settle_invocation(
    connection: ConnectionType,
    row: dict[str, Any],
    owner_id: str,
    actual: int | None,
    now: datetime,
) -> Reservation:
    quota = connection.execute(
        "SELECT * FROM quota_reservations WHERE id=%s FOR UPDATE",
        (row["reservation_id"],),
    ).fetchone()
    if (
        quota is None
        or str(quota["owner_id"]) != owner_id
        or quota["logical_run_id"] != row["run_id"]
    ):
        raise DomainError("ADMISSION_STATE_CONFLICT")
    _, known = usage_events(connection, row)
    result = settle_in_transaction(
        connection, str(row["reservation_id"]), actual if known else None, now
    )
    connection.execute(
        "UPDATE agent_invocations SET status='settled' WHERE id=%s", (row["id"],)
    )
    return result
