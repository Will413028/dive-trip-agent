"""Bounded private diagnostics for rejected model tool arguments."""

from typing import Annotated, Literal, cast, get_args

from pydantic import Field, ValidationError

from dive_trip.platform.schema import WireModel

ToolName = Literal[
    "find_destinations",
    "find_items",
    "calculate_budget",
    "validate_changes",
    "propose_changes",
]
IssueCode = Literal[
    "missing",
    "invalid_type",
    "invalid_value",
    "too_small",
    "too_big",
    "invalid_format",
    "extra_forbidden",
    "other",
]
PathToken = Literal[
    "changes",
    "kind",
    "value",
    "entry",
    "id",
    "catalogId",
    "day",
    "slot",
    "endDay",
    "rooms",
    "entryId",
    "destinationId",
    "days",
    "people",
    "divers",
    "startDate",
    "budgetMinor",
    "lodgingPreference",
    "pace",
    "validationId",
    "requirements",
    "add",
    "remove",
    "move",
    "replace",
    "*",
    "?",
]

_FIELDS = frozenset(get_args(PathToken))
_TYPE_ERRORS = frozenset(
    {
        "bool_type",
        "dict_type",
        "float_type",
        "int_type",
        "list_type",
        "model_type",
        "none_required",
        "string_type",
    }
)
_VALUE_ERRORS = frozenset(
    {
        "assertion_error",
        "literal_error",
        "union_tag_invalid",
        "union_tag_not_found",
        "value_error",
    }
)
_SMALL_ERRORS = frozenset(
    {"greater_than", "greater_than_equal", "too_short", "string_too_short"}
)
_BIG_ERRORS = frozenset(
    {"less_than", "less_than_equal", "too_long", "string_too_long"}
)
_FORMAT_ERRORS = frozenset(
    {"date_parsing", "string_pattern_mismatch", "uuid_parsing"}
)


class ArgumentIssue(WireModel):
    code: IssueCode
    path: Annotated[list[PathToken], Field(max_length=8)]


class ArgumentDiagnostic(WireModel):
    tool: ToolName
    candidate_ordinal: Annotated[int, Field(ge=1, le=6)]
    issues: Annotated[list[ArgumentIssue], Field(min_length=1, max_length=8)]


def _path(parts: tuple[object, ...], *, extra: bool = False) -> list[PathToken]:
    result: list[PathToken] = []
    for index, part in enumerate(parts[:8]):
        if extra and index == len(parts) - 1:
            result.append("?")
        elif type(part) is int:
            result.append("*")
        elif isinstance(part, str) and part in _FIELDS:
            result.append(cast(PathToken, part))
        else:
            result.append("?")
    return result


def _issue_code(value: str) -> IssueCode:
    if value in ("missing", "extra_forbidden"):
        return cast(IssueCode, value)
    if value in _TYPE_ERRORS:
        return "invalid_type"
    if value in _VALUE_ERRORS:
        return "invalid_value"
    if value in _SMALL_ERRORS:
        return "too_small"
    if value in _BIG_ERRORS:
        return "too_big"
    if value in _FORMAT_ERRORS:
        return "invalid_format"
    return "other"


def from_validation_error(
    tool: ToolName, candidate_ordinal: int, error: ValidationError
) -> ArgumentDiagnostic:
    issues: list[ArgumentIssue] = []
    seen: set[tuple[IssueCode, tuple[PathToken, ...]]] = set()
    errors = error.errors(include_input=False, include_context=False, include_url=False)
    for item in errors:
        code = _issue_code(item["type"])
        path = _path(item["loc"], extra=item["type"] == "extra_forbidden")
        identity = (code, tuple(path))
        if identity in seen:
            continue
        seen.add(identity)
        issues.append(ArgumentIssue(code=code, path=path))
        if len(issues) == 8:
            break
    return ArgumentDiagnostic(
        tool=tool, candidate_ordinal=candidate_ordinal, issues=issues
    )


def identifier_rejection(
    tool: ToolName, candidate_ordinal: int, path: tuple[object, ...]
) -> ArgumentDiagnostic:
    return ArgumentDiagnostic(
        tool=tool,
        candidate_ordinal=candidate_ordinal,
        issues=[ArgumentIssue(code="invalid_value", path=_path(path))],
    )
