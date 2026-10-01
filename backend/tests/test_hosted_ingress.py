import asyncio
from unittest.mock import Mock

import httpx
import pytest
from starlette.responses import Response

from dive_trip.bootstrap.hosted_ingress import HostedIngress, signature

KEY = "ab" * 32
STAMP = "1790812800"
NONCE = "12" * 16
CLIENT = "192.0.2.1"


async def endpoint(scope, receive, send):
    body = await receive()
    await Response(body["body"])(scope, receive, send)


def headers(target="/api/test?a=1", body=b"hello"):
    return {
        "x-dive-time": STAMP,
        "x-dive-nonce": NONCE,
        "x-dive-client": CLIENT,
        "x-dive-signature": signature(KEY, "POST", target, STAMP, NONCE, CLIENT, body),
    }


@pytest.mark.parametrize(
    "target,body,change,status",
    [
        ("/api/test?a=1", b"hello", {}, 200),
        ("/api/other?a=1", b"hello", {}, 403),
        ("/api/test?a=2", b"hello", {}, 403),
        ("/api/test?a=1", b"changed", {}, 403),
        ("/api/test?a=1", b"hello", {"x-dive-time": "1790812700"}, 403),
        ("/api/test?a=1", b"hello", {"x-dive-client": "not-an-ip"}, 403),
        ("/api/test?a=1", b"x" * 32769, {}, 413),
    ],
)
async def test_request_binding(target, body, change, status):
    store = Mock()
    store.consume.return_value = 200
    app = HostedIngress(endpoint, KEY, store, clock=lambda: int(STAMP))
    signed = headers()
    signed.update(change)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example" + target, content=body, headers=signed
        )
    assert response.status_code == status
    assert store.consume.call_count == (1 if status == 200 else 0)
    if status == 200:
        assert response.content == body
        assert store.consume.call_args.args[1] != CLIENT


@pytest.mark.parametrize("admitted", [409, 429])
async def test_shared_admission_rejects(admitted):
    store = Mock()
    store.consume.return_value = admitted
    app = HostedIngress(endpoint, KEY, store, clock=lambda: int(STAMP))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example/api/test?a=1", content=b"hello", headers=headers()
        )
    assert response.status_code == admitted
    assert response.headers["cache-control"] == "no-store"


async def test_duplicate_signature_rejected_before_database():
    store = Mock()
    app = HostedIngress(endpoint, KEY, store, clock=lambda: int(STAMP))
    duplicated = list(headers().items()) + [("X-Dive-Signature", "00" * 32)]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example/api/test?a=1", content=b"hello", headers=duplicated
        )
    assert response.status_code == 403
    store.consume.assert_not_called()


async def test_signature_expiring_during_body_read_is_rejected():
    store = Mock()
    readings = iter([int(STAMP), int(STAMP) + 31])
    app = HostedIngress(endpoint, KEY, store, clock=lambda: next(readings))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example/api/test?a=1", content=b"hello", headers=headers()
        )
    assert response.status_code == 403
    store.consume.assert_not_called()


async def test_slow_body_has_bounded_deadline():
    async def stream():
        yield b"hello"
        await asyncio.sleep(1)

    store = Mock()
    app = HostedIngress(
        endpoint, KEY, store, clock=lambda: int(STAMP), body_timeout=0.01
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example/api/test?a=1", content=stream(), headers=headers()
        )
    assert response.status_code == 408
    store.consume.assert_not_called()


async def test_signature_expiring_while_waiting_for_admission_is_rejected():
    store = Mock()
    store.consume.return_value = 200
    readings = iter([int(STAMP), int(STAMP), int(STAMP) + 31])
    app = HostedIngress(endpoint, KEY, store, clock=lambda: next(readings))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.post(
            "https://demo.example/api/test?a=1", content=b"hello", headers=headers()
        )
    assert response.status_code == 403
    store.consume.assert_called_once()
