"""Durable deletion intent and minimal completion receipt, owned by trips."""

from datetime import datetime
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.platform.errors import DomainError

ConnectionType = Connection[dict[str, Any]]


def find(connection: ConnectionType, owner: str, trip_id: str) -> dict[str, Any] | None:
    return connection.execute(
        "SELECT * FROM trip_deletion_jobs WHERE trip_id=%s AND owner_id=%s",
        (trip_id, owner),
    ).fetchone()


def request(
    connection: ConnectionType, owner: str, trip_id: str, workflow_ids: list[str]
) -> dict[str, Any]:
    connection.execute(
        "UPDATE trips SET deletion_requested_at=clock_timestamp() WHERE id=%s",
        (trip_id,),
    )
    row = connection.execute(
        "INSERT INTO trip_deletion_jobs(trip_id,owner_id,status,workflow_ids) "
        "VALUES(%s,%s,'deleting',%s) RETURNING *",
        (trip_id, owner, Jsonb(workflow_ids)),
    ).fetchone()
    assert row is not None
    return row


def pending(connection: ConnectionType) -> list[str]:
    return [
        str(row["trip_id"])
        for row in connection.execute(
            "SELECT trip_id FROM trip_deletion_jobs WHERE status='deleting' "
            "AND next_attempt_at<=clock_timestamp() "
            "ORDER BY next_attempt_at,trip_id LIMIT 100"
        ).fetchall()
    ]


def job(connection: ConnectionType, trip_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM trip_deletion_jobs WHERE trip_id=%s", (trip_id,)
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return row


def attempted(connection: ConnectionType, trip_id: str) -> None:
    connection.execute(
        "UPDATE trip_deletion_jobs SET next_attempt_at=clock_timestamp()+"
        "make_interval(secs=>5*power(2,least(attempts,8))),attempts=attempts+1 "
        "WHERE trip_id=%s AND status='deleting'",
        (trip_id,),
    )


def complete(connection: ConnectionType, trip_id: str) -> None:
    if job(connection, trip_id)["status"] == "deleted":
        return
    connection.execute("DELETE FROM trips WHERE id=%s", (trip_id,))
    connection.execute(
        "UPDATE trip_deletion_jobs SET status='deleted',workflow_ids='[]'::jsonb,"
        "completed_at=clock_timestamp(),next_attempt_at=clock_timestamp() "
        "WHERE trip_id=%s",
        (trip_id,),
    )


def completed_candidates(connection: ConnectionType) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT trip_id,owner_id FROM trip_deletion_jobs WHERE status='deleted' "
        "AND next_attempt_at<=clock_timestamp() "
        "ORDER BY next_attempt_at,trip_id LIMIT 1000"
    ).fetchall()


def defer_receipt_check(
    connection: ConnectionType, trip_id: str, expires_at: datetime
) -> None:
    connection.execute(
        "UPDATE trip_deletion_jobs SET next_attempt_at=%s "
        "WHERE trip_id=%s AND status='deleted'",
        (expires_at, trip_id),
    )


def prune_receipt(connection: ConnectionType, trip_id: str) -> int:
    return connection.execute(
        "DELETE FROM trip_deletion_jobs WHERE trip_id=%s AND status='deleted'",
        (trip_id,),
    ).rowcount
