import asyncio
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import psycopg
import pytest
import temporalio
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from temporalio.testing import WorkflowEnvironment

from dive_trip.platform.database import fixture_conninfo


@pytest.fixture(scope="module")
def temporal_binary():
    binary = (
        Path(tempfile.gettempdir()) / f"temporal-sdk-python-{temporalio.__version__}"
    )
    if not binary.is_file():

        async def provision():
            async with await WorkflowEnvironment.start_local():
                pass

        asyncio.run(provision())
    assert binary.is_file(), "Pinned SDK test server provisioning failed"
    return binary


@pytest.mark.parametrize("mode", ["cleanup", "retain", "drift"])
def test_owned_evaluator_process_cleans_success_and_retains_report_failure(
    postgres, mode, temporal_binary
):
    retain = mode != "cleanup"
    root = Path(__file__).resolve().parents[2]
    binary = temporal_binary
    port = int(conninfo_to_dict(postgres)["port"])
    with psycopg.connect(postgres, autocommit=True) as connection:
        if (
            connection.execute(
                "SELECT 1 FROM pg_database WHERE datname='dive_trip_test'"
            ).fetchone()
            is None
        ):
            connection.execute("CREATE DATABASE dive_trip_test")
    node = shutil.which("node")
    assert node is not None
    result = subprocess.run(
        [
            node,
            str(root / "backend/tests/evaluation-process-consumer.mjs"),
            str(port),
            str(binary),
            mode,
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stderr
    record = json.loads(result.stdout)["captured"]["record"]
    schema = record["retainedSchema"]
    assert schema.startswith("python_test_")
    storage = root / record["temporalStorage"]
    assert storage.parent.parent == root / ".artifacts"
    assert storage.parent.name.startswith("python-evaluation-")
    try:
        with psycopg.connect(fixture_conninfo(port), autocommit=True) as connection:
            exists = connection.execute(
                "SELECT to_regnamespace(%s)", (schema,)
            ).fetchone()[0]
            assert (exists is not None) == retain
            assert storage.exists() == retain
            if retain:
                connection.execute(
                    sql.SQL("SET search_path TO {}").format(sql.Identifier(schema))
                )
                assert connection.execute(
                    "SELECT current_version FROM trips"
                ).fetchone() == (2,)
                assert connection.execute(
                    "SELECT count(*) FROM model_calls"
                ).fetchone() == (2,)
    finally:
        if retain:
            with psycopg.connect(fixture_conninfo(port), autocommit=True) as connection:
                connection.execute(
                    sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(
                        sql.Identifier(schema)
                    )
                )
        shutil.rmtree(storage.parent)
