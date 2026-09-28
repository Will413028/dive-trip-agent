"""Display-only paths use escaped stable entry IDs, never executable JSON Patch."""

from copy import deepcopy
from typing import Any

from .domain import Snapshot


def diff_snapshots(before: Snapshot, after: Snapshot) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    missing = object()

    def escape(key: str) -> str:
        return key.replace("~", "~0").replace("/", "~1")

    def visit(left: Any, right: Any, path: str) -> None:
        if type(left) is type(right) and left == right:
            return
        if isinstance(left, list) and isinstance(right, list):
            if path == "/entries":
                old = {entry["id"]: entry for entry in left}
                new = {entry["id"]: entry for entry in right}
                for key in dict.fromkeys([*old, *new]):
                    visit(
                        old.get(key, missing),
                        new.get(key, missing),
                        f"{path}/{escape(key)}",
                    )
                old_order = [key for key in old if key in new]
                new_order = [key for key in new if key in old]
                if old_order != new_order:
                    changes.append(
                        {"path": path, "before": old_order, "after": new_order}
                    )
            else:
                for index in range(max(len(left), len(right))):
                    visit(
                        left[index] if index < len(left) else missing,
                        right[index] if index < len(right) else missing,
                        f"{path}/{index}",
                    )
        elif isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(left.keys() | right.keys()):
                visit(
                    left.get(key, missing),
                    right.get(key, missing),
                    f"{path}/{escape(key)}",
                )
        else:
            change = {"path": path}
            if left is not missing:
                change["before"] = deepcopy(left)
            if right is not missing:
                change["after"] = deepcopy(right)
            changes.append(change)

    visit(before.model_dump(mode="json"), after.model_dump(mode="json"), "")
    return changes
