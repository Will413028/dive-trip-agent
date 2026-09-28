"""Allowlisted projections only; never expose framework messages or tool data."""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import Field, TypeAdapter, ValidationError

from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import Nonempty, NonnegativeInt, WireModel

from .answer_contract import AcceptedAnswer

ProgressId = Annotated[
    str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.:-]+$")
]
ToolName = Literal[
    "find_destinations",
    "find_items",
    "calculate_budget",
    "validate_changes",
    "propose_changes",
]


class AnswerEvent(WireModel):
    type: Literal["CUSTOM"]
    name: Literal["dive_trip.answer.v1"]
    value: AcceptedAnswer


class ToolStart(WireModel):
    type: Literal["TOOL_CALL_START"]
    toolCallId: ProgressId
    toolCallName: ToolName


class ToolEnd(WireModel):
    type: Literal["TOOL_CALL_END"]
    toolCallId: ProgressId


class ToolResult(WireModel):
    type: Literal["TOOL_CALL_RESULT"]
    toolCallId: ProgressId
    messageId: ProgressId
    role: Literal["tool"]
    content: Literal["{}"]


class Started(WireModel):
    type: Literal["RUN_STARTED"]
    threadId: str
    runId: Nonempty
    timestamp: NonnegativeInt | None = None


class Success(WireModel):
    type: Literal["success", "cancelled"]


class Interrupt(WireModel):
    id: Annotated[Nonempty, Field(max_length=128, pattern=r"^[^\x00]+$")]
    reason: Literal["approval"]
    message: Literal["DEMO：請檢查差異後接受或拒絕修改。"] | None = None


class Interrupted(WireModel):
    type: Literal["interrupt"]
    interrupts: Annotated[list[Interrupt], Field(min_length=1, max_length=1)]


class Finished(WireModel):
    type: Literal["RUN_FINISHED"]
    threadId: str
    runId: Nonempty
    timestamp: NonnegativeInt | None = None
    outcome: Success | Interrupted | None = None


class Failed(WireModel):
    type: Literal["RUN_ERROR"]
    code: str | None = None
    message: str
    timestamp: NonnegativeInt | None = None


type PublicEvent = (
    AnswerEvent | ToolStart | ToolEnd | ToolResult | Started | Finished | Failed
)

Event: TypeAdapter[PublicEvent] = TypeAdapter(
    Annotated[
        PublicEvent,
        Field(discriminator="type"),
    ]
)


def parse_event(raw: Any, trip_id: str, run_id: str) -> dict[str, Any]:
    try:
        parsed = Event.validate_python(raw)
        if isinstance(parsed, AnswerEvent) and parsed.value.runId != run_id:
            raise ValueError("answer run mismatch")
        if isinstance(parsed, (Started, Finished)):
            UUID(parsed.threadId)
            # Legacy lifecycle runId identifies an invocation, while CUSTOM
            # answers identify the logical run. Preserve both stored identities.
            if parsed.threadId != trip_id:
                raise ValueError("lifecycle identity mismatch")
        if isinstance(parsed, Failed):
            # Stored messages are data, never public prose. Normalize even old rows.
            stale = parsed.code == "STALE_VERSION"
            return {
                "type": "RUN_ERROR",
                "code": "STALE_VERSION" if stale else "AGENT_INTERRUPTED",
                "message": "行程已更新，請重新整理後重新提案。"
                if stale
                else "執行未完整完成，請重新讀取行程確認已保存結果。",
            }
        return parsed.model_dump(mode="json", exclude_unset=True)
    except (ValidationError, ValueError) as error:
        raise DomainError("INVALID_RUN_EVENT") from error
