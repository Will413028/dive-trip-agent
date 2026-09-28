import asyncio
import json
import socket
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest

from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_channel import EvaluationChannel


@asynccontextmanager
async def pair():
    first, second = socket.socketpair()
    reader, writer = await asyncio.open_connection(sock=first, limit=1048576)
    peer_reader, peer_writer = await asyncio.open_connection(sock=second, limit=8388608)
    try:
        yield EvaluationChannel(reader, writer), peer_reader, peer_writer
    finally:
        writer.close()
        peer_writer.close()
        await asyncio.gather(writer.wait_closed(), peer_writer.wait_closed())


async def send(writer, value):
    writer.write(json.dumps(value).encode() + b"\n")
    await writer.drain()


async def receive(reader):
    async with asyncio.timeout(5):
        return json.loads(await reader.readline())


async def test_private_channel_requests_credential_only_within_active_command():
    async with pair() as (channel, reader, writer):
        with pytest.raises(DomainError, match="EVALUATION_CREDENTIAL_PHASE"):
            await channel.load_credential()

        async def handler(_command):
            value = await channel.load_credential()
            with pytest.raises(DomainError, match="EVALUATION_CREDENTIAL_PHASE"):
                await channel.load_credential()
            return {"synthetic": value == "synthetic-not-a-real-key"}

        task = asyncio.create_task(channel.serve(handler))
        identity = uuid4().hex
        await send(
            writer,
            {"kind": "command", "id": identity, "operation": "request", "input": {}},
        )
        credential = await receive(reader)
        assert credential["kind"] == "credential-request"
        assert credential["commandId"] == identity
        await send(
            writer,
            {
                "kind": "credential",
                "id": credential["id"],
                "value": "synthetic-not-a-real-key",
            },
        )
        assert await receive(reader) == {
            "kind": "result",
            "id": identity,
            "ok": True,
            "value": {"synthetic": True},
        }
        writer.close()
        await task


async def test_cancel_ack_waits_for_handler_cleanup_and_sanitizes_errors():
    async with pair() as (channel, reader, writer):
        entered, draining, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def handler(_command):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                draining.set()
                await release.wait()

        task = asyncio.create_task(channel.serve(handler))
        identity = uuid4().hex
        await send(
            writer,
            {"kind": "command", "id": identity, "operation": "request", "input": {}},
        )
        await entered.wait()
        await send(writer, {"kind": "cancel", "id": identity})
        await draining.wait()
        await send(writer, {"kind": "cancel", "id": identity})
        result = asyncio.create_task(receive(reader))
        await asyncio.sleep(0)
        assert not result.done()
        release.set()
        assert await result == {
            "kind": "result",
            "id": identity,
            "ok": False,
            "code": "EVALUATION_OPERATION_FAILED",
        }
        writer.close()
        await task


@pytest.mark.parametrize(
    "message",
    [
        {"kind": "credential", "id": "a" * 32, "value": "synthetic-not-a-real-key"},
        {
            "kind": "command",
            "id": "a" * 32,
            "operation": "request",
            "input": {},
            "credential": "synthetic-not-a-real-key",
        },
    ],
)
async def test_unsolicited_or_embedded_credentials_cannot_invoke_handler(message):
    async with pair() as (channel, _reader, writer):

        async def handler(_command):
            pytest.fail("protocol rejection must precede handler")

        task = asyncio.create_task(channel.serve(handler))
        await send(writer, message)
        with pytest.raises(DomainError):
            await task


async def test_raw_handler_exception_is_not_sent_to_parent():
    async with pair() as (channel, reader, writer):

        async def handler(_command):
            raise ValueError("synthetic-sensitive-sdk-message")

        task = asyncio.create_task(channel.serve(handler))
        identity = uuid4().hex
        await send(
            writer,
            {"kind": "command", "id": identity, "operation": "audit", "input": {}},
        )
        result = await receive(reader)
        assert result["code"] == "EVALUATION_OPERATION_FAILED"
        assert "synthetic-sensitive" not in json.dumps(result)
        writer.close()
        await task


async def test_next_command_can_arrive_after_result_before_write_drain(monkeypatch):
    async with pair() as (channel, reader, writer):
        original_send = channel.send
        release = asyncio.Event()
        calls = 0

        async def delayed_send(value):
            await original_send(value)
            if value.get("value") == 1:
                await release.wait()

        async def handler(_command):
            nonlocal calls
            calls += 1
            if calls == 2:
                release.set()
            return calls

        monkeypatch.setattr(channel, "send", delayed_send)
        task = asyncio.create_task(channel.serve(handler))
        try:
            for expected in (1, 2):
                await send(
                    writer,
                    {
                        "kind": "command",
                        "id": uuid4().hex,
                        "operation": "audit",
                        "input": {},
                    },
                )
                result = await receive(reader)
                assert result["value"] == expected
        finally:
            release.set()
            writer.close()
            await task
