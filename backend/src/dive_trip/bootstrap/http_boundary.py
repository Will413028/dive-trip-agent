import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class HttpBoundary:
    """Check origin and streaming size before decoding or database access."""

    def __init__(self, app: ASGIApp, origin: str) -> None:
        self.app, self.origin = app, origin

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def secure_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (b"cache-control", b"no-store"),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                    ]
                )
                message = {**message, "headers": headers}
            await send(message)

        async def reject(code: str, status: int = 400) -> None:
            await JSONResponse({"error": code}, status_code=status)(
                scope, receive, secure_send
            )

        if scope["method"] not in ("GET", "POST", "DELETE"):
            await reject("NOT_FOUND", 404)
            return
        if scope["method"] in ("POST", "DELETE"):
            for name, code in (
                (b"origin", "INVALID_ORIGIN"),
                (b"content-type", "INVALID_CONTENT_TYPE"),
                (b"content-length", "BODY_TOO_LARGE"),
            ):
                if sum(key.lower() == name for key, _ in scope["headers"]) > 1:
                    await reject(code)
                    return
            headers = {
                key.lower(): value.decode("latin-1") for key, value in scope["headers"]
            }
            if headers.get(b"origin") != self.origin:
                await reject("INVALID_ORIGIN")
                return
            if (
                headers.get(b"content-type", "").split(";")[0].strip().lower()
                != "application/json"
            ):
                await reject("INVALID_CONTENT_TYPE")
                return
            size = headers.get(b"content-length")
            if size and (
                not re.fullmatch(r"[0-9]+", size) or len(size) > 8 or int(size) > 32768
            ):
                await reject("BODY_TOO_LARGE")
                return
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > 32768:
                    await reject("BODY_TOO_LARGE")
                    return
                if not message.get("more_body", False):
                    break
            delivered = False

            async def replay_body() -> Message:
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {
                        "type": "http.request",
                        "body": bytes(body),
                        "more_body": False,
                    }
                return await receive()

            await self.app(scope, replay_body, secure_send)
        else:
            await self.app(scope, receive, secure_send)
