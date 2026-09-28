import hashlib
import re
import secrets
from datetime import datetime
from typing import Any
from uuid import uuid4

from psycopg import Connection

from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError


def require_owner(
    connection: Connection[dict[str, Any]],
    owner: str,
    *,
    lock: bool = False,
    exclusive: bool = False,
    not_before: datetime | None = None,
) -> None:
    if exclusive:
        connection.execute("SELECT id FROM sessions WHERE id=%s FOR UPDATE", (owner,))
    elif lock:
        connection.execute("SELECT id FROM sessions WHERE id=%s FOR SHARE", (owner,))
    if (
        connection.execute(
            """
        SELECT id FROM sessions WHERE id=%s AND expires_at>clock_timestamp()
        AND expires_at>COALESCE(%s::timestamptz,clock_timestamp())
        """,
            (owner, not_before),
        ).fetchone()
        is None
    ):
        raise DomainError("NOT_FOUND")


def owner_expiry(connection: Connection[dict[str, Any]], owner: str) -> datetime:
    row = connection.execute(
        "SELECT expires_at FROM sessions WHERE id=%s AND expires_at>clock_timestamp()",
        (owner,),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    result: datetime = row["expires_at"]
    return result


class Sessions:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create(self) -> tuple[str, str]:
        identity, token = str(uuid4()), secrets.token_hex(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)", (identity, digest)
            )
        return identity, token

    def resolve(self, cookie: str) -> str | None:
        values = [
            part.strip().removeprefix("dive_trip_session=")
            for part in cookie.split(";")
            if part.strip().startswith("dive_trip_session=")
        ]
        if len(values) != 1 or not re.fullmatch(r"[0-9a-f]{64}", values[0]):
            return None
        digest = hashlib.sha256(values[0].encode()).hexdigest()
        with self.database.transaction() as connection:
            row = connection.execute(
                """
                SELECT id FROM sessions WHERE token_hash=%s
                AND expires_at>clock_timestamp()
                """,
                (digest,),
            ).fetchone()
            return str(row["id"]) if row else None
