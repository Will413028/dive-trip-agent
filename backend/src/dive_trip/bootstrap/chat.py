"""AG-UI wire boundary and bounded observation of committed projections."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Coroutine
from typing import Annotated, Any, Literal, Self
from uuid import UUID

import anyio
from pydantic import Field, model_validator
from starlette.requests import Request

from dive_trip.application.dispatch import AgentDispatcher
from dive_trip.application.run_queries import RunQueries
from dive_trip.modules.planning.answer_contract import Version
from dive_trip.modules.planning.evidence import Binding
from dive_trip.platform.db_async import run_db
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import Nonempty, WireModel

TextId = Annotated[Nonempty, Field(max_length=128, pattern=r"^[^\x00]+$")]


class Message(WireModel):
    id: TextId
    role: Literal["user"]
    content: Annotated[Nonempty, Field(max_length=4000, pattern=r"^[^\x00]+$")]


class Confirmation(WireModel):
    confirmed: bool


class Resume(WireModel):
    interruptId: TextId
    status: Literal["resolved"]
    payload: Confirmation


class StartProps(WireModel):
    baseVersion: Version


class ResumeProps(WireModel):
    runId: str


class RunInput(WireModel):
    threadId: str
    runId: str
    protocolVersion: Literal["1.0"] = "1.0"
    messages: Annotated[list[Message], Field(max_length=1)]
    tools: Annotated[list[Any], Field(max_length=0)]
    context: Annotated[list[Any], Field(max_length=0)]
    state: Annotated[dict[str, Any], Field(max_length=0)]
    forwardedProps: StartProps | ResumeProps
    resume: Annotated[list[Resume], Field(max_length=1)] = []

    @model_validator(mode="after")
    def command(self) -> Self:
        UUID(self.threadId)
        UUID(self.runId)
        if self.resume:
            if self.messages or not isinstance(self.forwardedProps, ResumeProps):
                raise ValueError("invalid confirmation")
            UUID(self.forwardedProps.runId)
        elif not isinstance(self.forwardedProps, StartProps) or len(self.messages) != 1:
            raise ValueError("expected exactly one user message")
        return self


def encode_event(item: dict[str, Any]) -> str:
    content = json.dumps(item["event"], ensure_ascii=False, separators=(",", ":"))
    return f"id: {item['sequence']}\ndata: {content}\n\n"


async def start_while_connected(
    request: Request,
    dispatcher: AgentDispatcher,
    command: Callable[[], Coroutine[Any, Any, Binding]],
) -> Binding:
    # FastAPI has consumed the request body before entering this function.
    # Before StreamingResponse exists, no framework task watches disconnects.
    if await request.is_disconnected():
        raise DomainError("REQUEST_DISCONNECTED")
    disconnected = False

    async def watch() -> None:
        nonlocal disconnected
        while True:
            if (await request.receive())["type"] == "http.disconnect":
                disconnected = True
                return

    watcher = asyncio.create_task(watch())
    operation = asyncio.create_task(command())
    result: Binding | None = None
    parent_cancelled = False
    try:
        done, _ = await asyncio.wait(
            {watcher, operation}, return_when=asyncio.FIRST_COMPLETED
        )
        if watcher in done:
            await watcher
            operation.cancel()
        try:
            result = await operation
        except asyncio.CancelledError:
            if not disconnected:
                raise
    except asyncio.CancelledError:
        parent_cancelled = True
        raise
    finally:
        with anyio.CancelScope(shield=True):
            if not operation.done():
                operation.cancel()
            watcher.cancel()
            await asyncio.gather(operation, watcher, return_exceptions=True)
            if (
                parent_cancelled
                and not operation.cancelled()
                and operation.exception() is None
            ):
                await dispatcher.cancel(operation.result())
    if disconnected:
        if result is not None:
            await dispatcher.cancel(result)
        raise DomainError("REQUEST_DISCONNECTED")
    assert result is not None
    return result


async def observe(
    queries: RunQueries,
    dispatcher: AgentDispatcher,
    binding: Binding,
    *,
    resume: bool,
) -> AsyncIterator[str]:
    terminal = False
    sequence = 0
    phase = 0
    deadline = asyncio.get_running_loop().time() + 55
    try:
        while True:
            run = await run_db(
                queries.get,
                binding.ownerId,
                binding.tripId,
                binding.runId,
                after_sequence=sequence,
            )
            for item in run["events"]:
                if item["sequence"] > sequence:
                    sequence = item["sequence"]
                    if phase == int(resume):
                        yield encode_event(item)
                    if item["event"]["type"] in ("RUN_FINISHED", "RUN_ERROR"):
                        if phase == int(resume):
                            terminal = True
                            return
                        phase += 1
            if run["status"] != "running":
                terminal = True
                return
            if asyncio.get_running_loop().time() >= deadline:
                await dispatcher.cancel(binding)
                continue
            await asyncio.sleep(0.1)
    finally:
        if not terminal:
            # StreamingResponse cancels its task group on disconnect. Complete the
            # bounded DB fence even under that cancellation before leaving ASGI.
            with anyio.CancelScope(shield=True):
                with anyio.move_on_after(15):
                    await dispatcher.cancel(binding)
