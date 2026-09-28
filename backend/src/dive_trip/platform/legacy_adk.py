"""Version-pinned erasure of retired ADK storage; never executes an ADK agent."""

import re
from typing import Any

from psycopg import Connection, sql

from .errors import DomainError


def namespace(connection: Connection[dict[str, Any]]) -> str | None:
    row = connection.execute("SELECT current_schema() AS name").fetchone()
    assert row is not None
    schema = row["name"]
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,55}", schema):
        raise DomainError("INVALID_RETENTION_SCHEMA")
    adk = f"{schema}_adk"
    locked = connection.execute(
        "SELECT pg_try_advisory_xact_lock(724915,hashtext(%s)) AS ok", (adk,)
    ).fetchone()
    if locked is None or not locked["ok"]:
        raise DomainError("RUN_ACTIVE")
    exists = connection.execute(
        "SELECT to_regnamespace(%s) IS NOT NULL AS present", (adk,)
    ).fetchone()
    if exists is None or not exists["present"]:
        return None
    version = connection.execute(
        sql.SQL(
            "SELECT value FROM {}.adk_internal_metadata WHERE key='schema_version'"
        ).format(sql.Identifier(adk))
    ).fetchone()
    if version is None or version["value"] != "1":
        raise DomainError("UNSUPPORTED_ADK_SCHEMA")
    return adk


def erase_runs(
    connection: Connection[dict[str, Any]], owner: str, run_ids: list[str]
) -> None:
    if not run_ids:
        return
    adk = namespace(connection)
    if adk is None:
        return
    for run_id in run_ids:
        lock = connection.execute(
            "SELECT pg_try_advisory_xact_lock(724916,hashtext(%s)) AS ok",
            (f"{adk}:{run_id}",),
        ).fetchone()
        if lock is None or not lock["ok"]:
            raise DomainError("RUN_ACTIVE")
    connection.execute(
        sql.SQL(
            "DELETE FROM {}.events WHERE app_name=%s AND user_id=%s "
            "AND session_id=ANY(%s::text[])"
        ).format(sql.Identifier(adk)),
        ("dive_trip_fixture", owner, run_ids),
    )
    connection.execute(
        sql.SQL(
            "DELETE FROM {}.sessions WHERE app_name=%s AND user_id=%s "
            "AND id=ANY(%s::text[])"
        ).format(sql.Identifier(adk)),
        ("dive_trip_fixture", owner, run_ids),
    )
    connection.execute(
        sql.SQL(
            "DELETE FROM {}.user_states u WHERE app_name=%s AND user_id=%s "
            "AND NOT EXISTS(SELECT 1 FROM {}.sessions s "
            "WHERE s.app_name=u.app_name AND s.user_id=u.user_id)"
        ).format(sql.Identifier(adk), sql.Identifier(adk)),
        ("dive_trip_fixture", owner),
    )


def owner_protection(adk: str | None, owner_id: sql.Composable) -> sql.Composable:
    """SQL predicate only: caller owns eligibility, pagination and row locks."""
    return (
        sql.SQL("")
        if adk is None
        else sql.SQL(
            "AND NOT EXISTS(SELECT 1 FROM {}.sessions a WHERE a.user_id={}::text) "
            "AND NOT EXISTS(SELECT 1 FROM {}.events a WHERE a.user_id={}::text) "
        ).format(sql.Identifier(adk), owner_id, sql.Identifier(adk), owner_id)
    )


def erase_owner_state(
    connection: Connection[dict[str, Any]], adk: str | None, owner: str
) -> None:
    if adk is not None:
        connection.execute(
            sql.SQL(
                "DELETE FROM {}.user_states "
                "WHERE app_name='dive_trip_fixture' AND user_id=%s"
            ).format(sql.Identifier(adk)),
            (owner,),
        )
