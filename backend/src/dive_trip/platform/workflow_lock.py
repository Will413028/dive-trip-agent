"""Serialize outbound start/delete RPCs without holding product row locks."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
from psycopg import Connection

from .database import Database
from .db_async import run_db
from .errors import DomainError


@asynccontextmanager
async def workflow_lock(database: Database, identity: str) -> AsyncIterator[None]:
    transaction = database.transaction()
    connection: Connection[dict[str, Any]] | None = None

    def enter() -> None:
        nonlocal connection
        connection = transaction.__enter__()

    try:
        await run_db(enter)

        def claim() -> bool:
            assert connection is not None
            row = connection.execute(
                "SELECT pg_try_advisory_xact_lock(724921,hashtext(%s)) AS locked",
                (identity,),
            ).fetchone()
            return bool(row and row["locked"])

        if not await run_db(claim):
            raise DomainError("WORKFLOW_RPC_BUSY")
        yield
    finally:
        if connection is not None:
            with anyio.CancelScope(shield=True):
                await run_db(transaction.__exit__, None, None, None)
