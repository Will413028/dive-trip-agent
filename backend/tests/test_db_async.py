import asyncio
import threading
from contextlib import contextmanager
from contextvars import ContextVar

import anyio
import pytest

from dive_trip.platform.db_async import run_db
from dive_trip.platform.workflow_lock import workflow_lock


@pytest.mark.parametrize("cancellation", ["asyncio", "anyio"])
async def test_cancel_waits_for_transaction_to_finish(database, cancellation):
    entered, release, finished = (threading.Event() for _ in range(3))

    def save():
        try:
            with database.transaction() as connection:
                connection.execute("CREATE TABLE cancellation_receipt(value integer)")
                entered.set()
                assert release.wait(5)
                connection.execute("INSERT INTO cancellation_receipt VALUES(42)")
        finally:
            finished.set()

    scope = anyio.CancelScope()

    async def invoke():
        with scope:
            await run_db(save)

    task = asyncio.create_task(invoke())
    try:
        async with asyncio.timeout(5):
            while not entered.is_set():
                await asyncio.sleep(0.01)
        if cancellation == "asyncio":
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()  # repeated cancel must not detach the persistence hook
        else:
            scope.cancel()
        await asyncio.sleep(0.03)
        assert not task.done()
        assert not finished.is_set()
    finally:
        release.set()
        if cancellation == "asyncio":
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await task
    assert finished.is_set()
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT value FROM cancellation_receipt").fetchone()[
                "value"
            ]
            == 42
        )


async def test_db_work_preserves_context_and_failure():
    context = ContextVar("db-test", default="unset")
    context.set("binding")
    assert await run_db(context.get) == "binding"

    def fail():
        raise ValueError("transaction failed")

    with pytest.raises(ValueError, match="transaction failed"):
        await run_db(fail)


async def test_cancel_during_rpc_lock_acquisition_returns_pool_connection(
    database, monkeypatch
):
    entered, release = threading.Event(), threading.Event()
    original = database.transaction
    database.pool.resize(1, 1)

    @contextmanager
    def delayed_transaction():
        with original() as connection:
            entered.set()
            assert release.wait(5)
            yield connection

    monkeypatch.setattr(database, "transaction", delayed_transaction)

    async def acquire():
        async with workflow_lock(database, "cancelled-lock"):
            raise AssertionError("cancelled acquisition must not enter body")

    task = asyncio.create_task(acquire())
    try:
        async with asyncio.timeout(5):
            while not entered.is_set():
                await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.sleep(0.03)
        assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    # The pool has only one connection. An abandoned context would exhaust it.
    with database.pool.connection(timeout=1) as connection:
        assert connection.execute("SELECT 1 AS value").fetchone()["value"] == 1
