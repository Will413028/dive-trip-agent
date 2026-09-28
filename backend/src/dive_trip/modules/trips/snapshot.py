from typing import Any

from .domain import Snapshot
from .proposal import build_proposal


def parse_snapshot(value: Any) -> Snapshot:
    snapshot = Snapshot.model_validate(value)
    catalog = {entry.item.id: entry.item for entry in snapshot.entries}
    draft = build_proposal(snapshot, [], list(catalog.values()), "user")
    if not draft.canApply:
        raise ValueError("INVALID_SNAPSHOT")
    return snapshot
