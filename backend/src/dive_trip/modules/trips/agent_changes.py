"""Expand model patches against the original bound requirements in order."""

from typing import Any

from .changes import Change, parse_changes
from .domain import Requirements, Snapshot

_NULLABLE = {"destinationId", "startDate", "budgetMinor"}


def expand_agent_changes(base: Snapshot, value: Any) -> list[Change]:
    if not isinstance(value, list) or not 1 <= len(value) <= 100:
        raise ValueError("INVALID_AGENT_CHANGES")
    requirements = base.requirements.model_dump(mode="json")
    expanded: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict) or raw.get("kind") == "lock":
            raise ValueError("INVALID_AGENT_CHANGES")
        if raw.get("kind") == "requirements":
            if set(raw) != {"kind", "value"}:
                raise ValueError("INVALID_AGENT_CHANGES")
            patch = raw["value"]
            if (
                not isinstance(patch, dict)
                or not patch
                or set(patch) - Requirements.model_fields.keys()
                or any(
                    item is None and key not in _NULLABLE for key, item in patch.items()
                )
            ):
                raise ValueError("INVALID_REQUIREMENTS_PATCH")
            requirements = Requirements.model_validate(
                {**requirements, **patch}
            ).model_dump(mode="json")
            if len(requirements["lodgingPreference"]) > 500:
                raise ValueError("INVALID_REQUIREMENTS_PATCH")
            expanded.append({"kind": "requirements", "value": requirements.copy()})
        else:
            expanded.append(raw)
    result = parse_changes(expanded)
    for change in result:
        data = change.model_dump()
        identifiers = data.get("entry", data)
        for field in ("id", "entryId", "catalogId"):
            if field in identifiers:
                text = identifiers[field]
                if len(text) > 128 or "\0" in text:
                    raise ValueError("INVALID_AGENT_IDENTIFIER")
    return result
