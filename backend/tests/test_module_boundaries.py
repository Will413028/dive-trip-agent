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


def test_layers_only_import_downward():
    """bootstrap → application → modules → platform; never the other way."""
    src = Path(__file__).resolve().parents[1] / "src" / "dive_trip"
    above = {
        "platform": ("modules", "application", "bootstrap"),
        "modules": ("application", "bootstrap"),
    }
    violations = []
    for layer, forbidden in above.items():
        for path in (src / layer).rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom) and node.module:
                    modules = [node.module]
                elif isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                else:
                    continue
                for module in modules:
                    parts = module.split(".")
                    if parts[0] == "dive_trip" and parts[1:2] and parts[1] in forbidden:
                        violations.append(
                            f"{path.relative_to(src)}:{node.lineno} imports {module}"
                        )
    assert violations == []
