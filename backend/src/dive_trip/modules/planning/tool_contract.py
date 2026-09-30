"""Strict provider-independent tool arguments and whole-candidate validation."""

import json
from typing import Annotated, Any, Literal, TypedDict, cast
from uuid import UUID

from pydantic import ConfigDict, Field, ValidationError, model_validator, with_config

from dive_trip.modules.catalog.public import Destination
from dive_trip.modules.trips.public import (
    AddChange,
    MoveChange,
    RemoveChange,
    ReplaceChange,
    RoomsChange,
)
from dive_trip.platform.errors import DomainError, ToolArgumentsRejected
from dive_trip.platform.schema import (
    CalendarDate,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)

from .answer_contract import AnswerPlan
from .argument_diagnostic import (
    ToolName,
    from_validation_error,
    identifier_rejection,
)


@with_config(ConfigDict(strict=True, extra="forbid"))
class RequirementsPatch(TypedDict, total=False):
    destinationId: Destination | None
    days: Annotated[PositiveInt, Field(ge=2, le=7)]
    people: Annotated[PositiveInt, Field(le=6)]
    divers: Annotated[NonnegativeInt, Field(le=6)]
    startDate: CalendarDate | None
    budgetMinor: NonnegativeInt | None
    lodgingPreference: Annotated[str, Field(max_length=500)]
    pace: Literal["relaxed", "balanced"]


class RequirementsPatchChange(WireModel):
    kind: Literal["requirements"]
    value: RequirementsPatch

    @model_validator(mode="after")
    def nonempty(self) -> "RequirementsPatchChange":
        if not self.value:
            raise ValueError("requirements patch must not be empty")
        return self


AgentChange = Annotated[
    RequirementsPatchChange
    | AddChange
    | MoveChange
    | RemoveChange
    | ReplaceChange
    | RoomsChange,
    Field(discriminator="kind"),
]


class EmptyArguments(WireModel):
    pass


class FindItemsArguments(WireModel):
    destinationId: Destination


class ValidateArguments(WireModel):
    changes: Annotated[list[AgentChange], Field(min_length=1, max_length=100)]


class ProposeArguments(WireModel):
    validationId: str

    @model_validator(mode="after")
    def uuid(self) -> "ProposeArguments":
        UUID(self.validationId)
        return self


TOOL_ARGUMENTS: dict[str, type[WireModel]] = {
    "find_destinations": EmptyArguments,
    "find_items": FindItemsArguments,
    "calculate_budget": EmptyArguments,
    "validate_changes": ValidateArguments,
    "propose_changes": ProposeArguments,
    "final_answer": AnswerPlan,
}


class ToolInvocation(WireModel):
    id: Annotated[
        str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.:-]+$")
    ]
    name: str
    args: dict[str, Any]


def tool_limit_code(raw: list[Any]) -> str:
    """Classify names only; this neither validates calls nor retains their values."""
    categories: set[str] = set()
    for value in raw:
        if not isinstance(value, dict) or not isinstance(value.get("name"), str):
            categories.add("invalid")
        elif value["name"] not in TOOL_ARGUMENTS:
            categories.add("undeclared")
        elif value["name"] == "final_answer":
            categories.add("final")
        elif value["name"] == "calculate_budget":
            categories.add("budget")
        else:
            categories.add("business")
    if "invalid" in categories:
        return "AGENT_TOOL_LIMIT_INVALID_NAME_SHAPE"
    if "undeclared" in categories:
        return "AGENT_TOOL_LIMIT_UNDECLARED_NAME"
    if len(categories) != 1:
        return "AGENT_TOOL_LIMIT_MIXED_NAMES"
    return {
        "final": "AGENT_TOOL_LIMIT_FINAL_ONLY",
        "budget": "AGENT_TOOL_LIMIT_BUDGET_ONLY",
        "business": "AGENT_TOOL_LIMIT_BUSINESS_ONLY",
    }[categories.pop()]


def validate_candidate(
    raw: Any, prior_ids: set[str], tool_count: int, *, proposed: bool = False
) -> list[ToolInvocation]:
    if not isinstance(raw, list):
        raise DomainError("AGENT_MODEL_RESPONSE_CANDIDATES_SHAPE")
    if not raw:
        raise DomainError("AGENT_MODEL_RESPONSE_EMPTY_CALLS")
    if len(json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode()) > 32000:
        raise DomainError("AGENT_OUTPUT_LIMIT")
    if tool_count + len(raw) > 6:
        raise DomainError(tool_limit_code(raw))
    parsed: list[ToolInvocation] = []
    seen = prior_ids.copy()
    for candidate_ordinal, value in enumerate(raw, start=1):
        call = ToolInvocation.model_validate(value)
        if call.name not in TOOL_ARGUMENTS:
            raise DomainError("AGENT_TOOL_NOT_ALLOWED")
        if call.id in prior_ids:
            raise DomainError("AGENT_MODEL_RESPONSE_REUSED_CALL_ID")
        if call.id in seen:
            raise DomainError("AGENT_MODEL_RESPONSE_DUPLICATE_CALL_ID")
        seen.add(call.id)
        try:
            args = (
                TOOL_ARGUMENTS[call.name]
                .model_validate(call.args)
                .model_dump(mode="json")
            )
        except ValidationError as error:
            if call.name == "final_answer":
                raise DomainError("AGENT_ANSWER_SCHEMA") from None
            raise ToolArgumentsRejected(
                from_validation_error(
                    cast(ToolName, call.name), candidate_ordinal, error
                )
            ) from None
        for index, change in enumerate(args.get("changes", [])):
            identifiers = change.get("entry", change)
            for key in ("id", "entryId", "catalogId"):
                if key in identifiers and (
                    len(identifiers[key]) > 128 or "\0" in identifiers[key]
                ):
                    path: tuple[object, ...] = ("changes", index)
                    if "entry" in change:
                        path += ("entry",)
                    raise ToolArgumentsRejected(
                        identifier_rejection(
                            cast(ToolName, call.name), candidate_ordinal, (*path, key)
                        )
                    )
        if call.name == "final_answer" and len(raw) != 1:
            raise DomainError("AGENT_ANSWER_SCHEMA")
        if call.name == "propose_changes" and (proposed or len(raw) != 1):
            raise DomainError("AGENT_PROPOSAL_LIMIT")
        parsed.append(call.model_copy(update={"args": args}))
    return parsed
