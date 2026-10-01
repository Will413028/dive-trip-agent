"""Signed, bounded ingress. Client headers never select an upstream or actor."""

import asyncio
import hashlib
import hmac
import ipaddress
import re
import time
from collections.abc import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from dive_trip.platform.db_async import run_db

from .hosted_storage import HostedIngressStore


def signature(
    key: str, method: str, target: str, stamp: str, nonce: str, client: str, body: bytes
) -> str:
    message = "\n".join(
        (
            "dive-ingress-v1",
            method,
            target,
            stamp,
            nonce,
            client,
            hashlib.sha256(body).hexdigest(),
        )
    )
    return hmac.new(bytes.fromhex(key), message.encode(), hashlib.sha256).hexdigest()


class HostedIngress:
    def __init__(
        self,
        app: ASGIApp,
        key: str,
        store: HostedIngressStore,
        clock: Callable[[], float] = time.time,
        body_timeout: float = 10,
    ) -> None:
        if not 0 < body_timeout <= 10:
            raise ValueError("HOSTED_BODY_TIMEOUT_INVALID")
        self.app, self.key, self.store, self.clock = app, key, store, clock
        self.body_timeout = body_timeout

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def reject(status: int, code: str) -> None:
            await JSONResponse(
                {"error": code},
                status_code=status,
                headers={"Cache-Control": "no-store"},
            )(scope, receive, send)

        names = (b"x-dive-time", b"x-dive-nonce", b"x-dive-client", b"x-dive-signature")
        if any(
            sum(k.lower() == name for k, _ in scope["headers"]) != 1 for name in names
        ):
            await reject(403, "INGRESS_REQUIRED")
            return
        headers = {k.lower(): v.decode("latin-1") for k, v in scope["headers"]}
        stamp, nonce, client, signed = (headers[name] for name in names)
        try:
            canonical_ip = str(ipaddress.ip_address(client))
        except ValueError:
            canonical_ip = ""
        if (
            not re.fullmatch(r"[0-9]{10}", stamp)
            or abs(self.clock() - int(stamp)) > 30
            or not re.fullmatch(r"[a-f0-9]{32}", nonce)
            or not re.fullmatch(r"[a-f0-9]{64}", signed)
            or canonical_ip != client
        ):
            await reject(403, "INGRESS_INVALID")
            return
        body = bytearray()
        try:
            async with asyncio.timeout(self.body_timeout):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > 32768:
                        await reject(413, "BODY_TOO_LARGE")
                        return
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            await reject(408, "BODY_TIMEOUT")
            return
        if abs(self.clock() - int(stamp)) > 30:
            await reject(403, "INGRESS_INVALID")
            return
        target = scope.get("raw_path", scope["path"].encode()).decode("latin-1")
        query = scope.get("query_string", b"")
        if query:
            target += "?" + query.decode("latin-1")
        expected = signature(
            self.key, scope["method"], target, stamp, nonce, client, bytes(body)
        )
        if not hmac.compare_digest(signed, expected):
            await reject(403, "INGRESS_INVALID")
            return
        client_hash = hmac.new(
            bytes.fromhex(self.key), ("client-v1:" + client).encode(), hashlib.sha256
        ).hexdigest()
        try:
            admitted = await run_db(self.store.consume, nonce, client_hash)
        except Exception:
            await reject(503, "SERVICE_UNAVAILABLE")
            return
        if abs(self.clock() - int(stamp)) > 30:
            await reject(403, "INGRESS_INVALID")
            return
        if admitted != 200:
            await reject(
                admitted, "INGRESS_REPLAY" if admitted == 409 else "RATE_LIMITED"
            )
            return
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
