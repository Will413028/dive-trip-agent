import asyncio
import json
import threading
from uuid import uuid4

import pytest
from starlette.requests import Request
from temporalio.testing import WorkflowEnvironment
from test_chat_http import ORIGIN, setup, start_body

from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.bootstrap.api import create_app
from dive_trip.bootstrap.chat import start_while_connected


@pytest.mark.parametrize("phase", ["commit", "rpc"])
async def test_asgi_disconnect_during_start_drains_and_fences(
    database, monkeypatch, phase
):
    _, token, trip, service = setup(database)
    paused, disconnected = asyncio.Event(), asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    async with await WorkflowEnvironment.start_local() as environment:
        dispatcher = FixtureDispatcher(service, environment.client, f"idle-{uuid4()}")
        if phase == "commit":
            original = service.start

            def delayed_commit(*args, **kwargs):
                result = original(*args, **kwargs)
                loop.call_soon_threadsafe(paused.set)
                assert release.wait(5)
                return result

            monkeypatch.setattr(service, "start", delayed_commit)
        else:
            original_rpc = environment.client.start_workflow

            async def delayed_ack(*args, **kwargs):
                await original_rpc(*args, **kwargs)
                paused.set()
                await asyncio.Event().wait()

            monkeypatch.setattr(environment.client, "start_workflow", delayed_ack)
        app = create_app(database, service.catalog, ORIGIN, dispatcher=dispatcher)
        body = json.dumps(start_body(trip.id)).encode()
        received = False
        messages = []

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": body, "more_body": False}
            await paused.wait()
            disconnected.set()
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": f"/api/trips/{trip.id}/agent",
            "query_string": b"",
            "headers": [
                (b"origin", ORIGIN.encode()),
                (b"content-type", b"application/json"),
                (b"cookie", f"dive_trip_session={token}".encode()),
            ],
            "server": ("localhost", 3000),
            "client": ("127.0.0.1", 12345),
            "root_path": "",
        }
        task = asyncio.create_task(app(scope, receive, send))
        try:
            async with asyncio.timeout(10):
                await paused.wait()
                await disconnected.wait()
                if phase == "commit":
                    await asyncio.sleep(0.03)
                    assert not task.done()
                release.set()
                await task
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        with database.transaction() as connection:
            row = connection.execute(
                "SELECT r.status,e.cancellation_requested,e.model_steps "
                "FROM agent_runs r JOIN planning_executions e ON e.run_id=r.id"
            ).fetchone()
            assert row == {
                "status": "interrupted",
                "cancellation_requested": True,
                "model_steps": 0,
            }
        assert b"RUN_STARTED" not in b"".join(m.get("body", b"") for m in messages)


async def test_parent_cancel_after_start_done_still_fences_binding(
    database, monkeypatch
):
    identity, _, trip, service = setup(database)
    paused = asyncio.Event()
    wait = asyncio.wait

    async def hold_result(tasks, **kwargs):
        result = await wait(tasks, **kwargs)
        if any(task.get_coro().__name__ == "command" for task in tasks):
            paused.set()
            await asyncio.Event().wait()
        return result

    async def receive():
        await asyncio.Event().wait()

    async with await WorkflowEnvironment.start_local() as environment:
        dispatcher = FixtureDispatcher(service, environment.client, "idle")
        request = Request({"type": "http"}, receive)

        async def command():
            return await dispatcher.start(
                identity, trip.id, "outer-cancel", "fixture", 1
            )

        monkeypatch.setattr(asyncio, "wait", hold_result)
        task = asyncio.create_task(start_while_connected(request, dispatcher, command))
        try:
            async with asyncio.timeout(10):
                await paused.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        with database.transaction() as connection:
            assert connection.execute(
                "SELECT r.status,e.cancellation_delivered FROM agent_runs r "
                "JOIN planning_executions e ON e.run_id=r.id"
            ).fetchone() == {"status": "interrupted", "cancellation_delivered": True}
