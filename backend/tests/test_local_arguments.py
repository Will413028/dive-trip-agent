"""Reject protected targets and legacy capabilities before opening any service."""

import sys

import pytest

from dive_trip.bootstrap.local import arguments


@pytest.mark.parametrize(
    "extra",
    [
        ["--schema", "workbench_live"],
        ["--schema", "test_" + "a" * 32],
        ["--live-free"],
        ["--live-openrouter-free"],
        ["--live-cloudflare-free"],
        ["--database-port", "0"],
        ["--database-url", "postgres://127.0.0.1/protected"],
    ],
)
def test_local_refuses_retired_or_unbounded_configuration(monkeypatch, extra):
    monkeypatch.setattr(
        sys, "argv", ["local", "migrate", "--database-port", "5432", *extra]
    )
    with pytest.raises(SystemExit) as error:
        arguments()
    assert error.value.code == 2


@pytest.mark.parametrize("extra", [[], ["--temporal-storage", "/tmp/synthetic.sqlite"]])
def test_serve_requires_explicit_persistent_storage_and_installed_binary(
    monkeypatch, extra
):
    monkeypatch.setattr(
        sys, "argv", ["local", "serve", "--database-port", "5432", *extra]
    )
    with pytest.raises(SystemExit) as error:
        arguments()
    assert error.value.code == 2


@pytest.mark.parametrize("flag", ["--apply", "--watch"])
def test_retention_cli_is_read_only_worker_owns_cleanup(monkeypatch, flag):
    monkeypatch.setattr(
        sys, "argv", ["local", "retention", "--database-port", "5432", flag]
    )
    with pytest.raises(SystemExit) as error:
        arguments()
    assert error.value.code == 2
