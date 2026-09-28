"""Prevent private imports from rebuilding the old cross-module monolith."""

import ast
from pathlib import Path


def test_modules_only_import_public_interfaces_of_other_modules():
    root = Path(__file__).resolve().parents[1] / "src" / "dive_trip" / "modules"
    violations = []
    for path in root.rglob("*.py"):
        owner = path.relative_to(root).parts[0]
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.module:
                parts = node.module.split(".")
                if (
                    parts[:2] == ["dive_trip", "modules"]
                    and parts[2] != owner
                    and parts[-1] not in ("public", "transactions")
                ):
                    violations.append(
                        f"{path.name}:{node.lineno} imports {node.module}"
                    )
    assert violations == []
