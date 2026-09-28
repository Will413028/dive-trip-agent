"""Bounded private inherited stream; never a listening socket or HTTP endpoint."""

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from uuid import uuid4

import anyio
from pydantic import Field, TypeAdapter

from .errors import DomainError
from .schema import WireModel

MAX_MESSAGE = 1048576
MAX_RESPONSE = 8 * MAX_MESSAGE


class Command(WireModel):
    kind: Literal["command"]
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    operation: Literal["setup", "request", "audit", "capture", "finish"]
    input: dict[str, Any]


class Cancel(WireModel):
    kind: Literal["cancel"]
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


class Credential(WireModel):
    kind: Literal["credential"]
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    value: str = Field(min_length=1, max_length=8192, repr=False)


INCOMING: TypeAdapter[Command | Cancel | Credential] = TypeAdapter(
    Command | Cancel | Credential
)


class EvaluationChannel:
    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.reader, self.writer = reader, writer
        self.write_lock = asyncio.Lock()
        self.active: tuple[str, asyncio.Task[None]] | None = None
        self.credential: tuple[str, asyncio.Future[str]] | None = None
        self.credential_issued = False
        self.seen: set[str] = set()
        self.tasks: set[asyncio.Task[None]] = set()

    async def send(self, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        if len(encoded) > MAX_RESPONSE:
            raise DomainError("EVALUATION_RESPONSE_TOO_LARGE")
        async with self.write_lock, asyncio.timeout(5):
            self.writer.write(encoded + b"\n")
            await self.writer.drain()

    async def load_credential(self) -> str:
        if self.active is None or self.credential_issued:
            raise DomainError("EVALUATION_CREDENTIAL_PHASE")
        self.credential_issued = True
        identity = uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.credential = identity, future
        try:
            await self.send(
                {
                    "kind": "credential-request",
                    "id": identity,
                    "commandId": self.active[0],
                }
            )
            async with asyncio.timeout(25):
                return await future
        finally:
            self.credential = None

    async def execute(
        self,
        command: Command,
        handler: Callable[[Command], Awaitable[Any]],
    ) -> None:
        try:
            value = await handler(command)
            response = {"kind": "result", "id": command.id, "ok": True, "value": value}
        except BaseException as error:
            code = (
                error.code
                if isinstance(error, DomainError)
                and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", error.code)
                else "EVALUATION_OPERATION_FAILED"
            )
            response = {"kind": "result", "id": command.id, "ok": False, "code": code}
        # The handler and its cleanup are done before bytes become visible to
        # the parent. A subsequent command may arrive before drain() resumes.
        self.active = None
        try:
            with anyio.CancelScope(shield=True):
                await self.send(response)
        except Exception:
            # An unsent result is never acknowledged. Closing the channel makes
            # the controller retain storage instead of waiting on a lost task.
            self.writer.close()

    async def serve(self, handler: Callable[[Command], Awaitable[Any]]) -> None:
        try:
            while raw := await self.reader.readline():
                if len(raw) > MAX_MESSAGE or not raw.endswith(b"\n"):
                    raise DomainError("EVALUATION_PROTOCOL_INVALID")
                try:
                    message = INCOMING.validate_json(raw)
                except ValueError:
                    raise DomainError("EVALUATION_PROTOCOL_INVALID") from None
                if isinstance(message, Command):
                    if self.active is not None or message.id in self.seen:
                        raise DomainError("EVALUATION_COMMAND_CONFLICT")
                    if len(self.seen) >= 1024:
                        raise DomainError("EVALUATION_COMMAND_LIMIT")
                    self.seen.add(message.id)
                    self.credential_issued = False
                    task = asyncio.create_task(self.execute(message, handler))
                    self.active = message.id, task
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                    if message.operation == "finish":
                        await task
                        break
                elif isinstance(message, Credential):
                    if (
                        self.credential is None
                        or self.credential[0] != message.id
                        or self.credential[1].done()
                    ):
                        raise DomainError("EVALUATION_CREDENTIAL_PHASE")
                    self.credential[1].set_result(message.value)
                elif self.active is not None and self.active[0] == message.id:
                    if not self.active[1].cancelling():
                        self.active[1].cancel()
                elif message.id not in self.seen:
                    raise DomainError("EVALUATION_COMMAND_CONFLICT")
        finally:
            if self.active is not None:
                task = self.active[1]
                if not task.cancelling():
                    task.cancel()
                with anyio.CancelScope(shield=True):
                    await asyncio.gather(task, return_exceptions=True)
            with anyio.CancelScope(shield=True):
                await asyncio.gather(*self.tasks, return_exceptions=True)
            self.writer.close()
            await self.writer.wait_closed()
