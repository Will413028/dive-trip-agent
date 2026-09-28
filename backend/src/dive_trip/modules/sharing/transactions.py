import hashlib
import re
import secrets
from datetime import datetime
from typing import Any
from uuid import uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.platform.errors import DomainError

from .public import PublicTrip

ConnectionType = Connection[dict[str, Any]]


def timestamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create(
    connection: ConnectionType,
    trip_id: str,
    version: int,
    preview: PublicTrip,
    expires_at: datetime,
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT count(*) AS n FROM trip_shares WHERE trip_id=%s", (trip_id,)
    ).fetchone()
    assert row is not None
    if row["n"] >= 20:
        raise DomainError("SHARE_LIMIT")
    identity, token = str(uuid4()), secrets.token_hex(32)
    connection.execute(
        "INSERT INTO trip_shares(id,trip_id,version,token_hash,snapshot,expires_at) "
        "VALUES(%s,%s,%s,%s,%s,%s)",
        (
            identity,
            trip_id,
            version,
            hashlib.sha256(token.encode()).hexdigest(),
            Jsonb(preview.model_dump(mode="json")),
            expires_at,
        ),
    )
    return {
        "id": identity,
        "token": token,
        "version": version,
        "expiresAt": timestamp(expires_at),
    }


def list_shares(connection: ConnectionType, trip_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT id,version,expires_at,revoked_at IS NOT NULL AS revoked "
        "FROM trip_shares WHERE trip_id=%s ORDER BY created_at DESC,id",
        (trip_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "version": row["version"],
            "expiresAt": timestamp(row["expires_at"]),
            "revoked": row["revoked"],
        }
        for row in rows
    ]


def revoke(connection: ConnectionType, trip_id: str, share_id: str) -> None:
    result = connection.execute(
        "UPDATE trip_shares SET revoked_at=COALESCE(revoked_at,clock_timestamp()) "
        "WHERE id=%s AND trip_id=%s",
        (share_id, trip_id),
    )
    if result.rowcount != 1:
        raise DomainError("NOT_FOUND")


def find_token(connection: ConnectionType, token: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        return None
    return connection.execute(
        "SELECT trip_id,snapshot FROM trip_shares WHERE token_hash=%s "
        "AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        (hashlib.sha256(token.encode()).hexdigest(),),
    ).fetchone()
