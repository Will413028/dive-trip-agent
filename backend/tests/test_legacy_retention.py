import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from test_chat_http import setup

from dive_trip.application.deletion import DeletionService
from dive_trip.application.retention import RetentionService
from dive_trip.modules.identity.public import Sessions
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def test_real_adk_history_is_erased_atomically_but_orphans_remain(database):
    owner, _, trip, planning = setup(database)
    orphan, _ = Sessions(database).create()
    empty, _ = Sessions(database).create()
    row, _ = planning.start(owner, trip.id, "legacy", "fixture", 1)
    with database.transaction() as connection:
        connection.execute(
            "DELETE FROM planning_executions WHERE run_id=%s", (row["id"],)
        )
        connection.execute(
            "UPDATE agent_runs SET executor='adk',status='succeeded',"
            "lease_expires_at=NULL "
            "WHERE id=%s",
            (row["id"],),
        )
    input_value = {
        "port": int(psycopg.conninfo.conninfo_to_dict(database.pool.conninfo)["port"]),
        "schema": database.schema,
        "sessions": [
            {"owner": owner, "run": str(row["id"])},
            {"owner": orphan, "run": str(uuid4())},
        ],
    }
    adk = f"{database.schema}_adk"
    try:
        created = subprocess.run(
            ["node", str(Path(__file__).with_name("legacy-adk-fixture.mjs"))],
            input=json.dumps(input_value),
            text=True,
            capture_output=True,
            timeout=30,
            env={"PATH": os.environ["PATH"]},
        )
        assert created.returncode == 0, created.stderr
        assert "LEGACY_FIXTURE_READY" in created.stdout
        service = DeletionService(database)
        assert service.request(owner, trip.id) == {"status": "deleting"}
        assert service.job(trip.id)["workflow_ids"] == []
        # A held SDK invocation lock must retain the entire content graph.
        with database.transaction() as locked:
            locked.execute(
                "SELECT pg_advisory_xact_lock(724916,hashtext(%s))",
                (f"{adk}:{row['id']}",),
            )
            with pytest.raises(DomainError, match="RUN_ACTIVE"):
                service.complete(trip.id)
            assert (
                locked.execute("SELECT count(*) AS n FROM trips").fetchone()["n"] == 1
            )
        # Unknown SDK schema version must also retain the graph.
        with database.transaction() as connection:
            connection.execute(
                sql.SQL(
                    "UPDATE {}.adk_internal_metadata SET value='2' "
                    "WHERE key='schema_version'"
                ).format(sql.Identifier(adk))
            )
        with pytest.raises(DomainError, match="UNSUPPORTED_ADK_SCHEMA"):
            service.complete(trip.id)
        with database.transaction() as connection:
            connection.execute(
                sql.SQL(
                    "UPDATE {}.adk_internal_metadata SET value='1' "
                    "WHERE key='schema_version'"
                ).format(sql.Identifier(adk))
            )
        service.complete(trip.id)
        assert service.status(owner, trip.id) == {"status": "deleted"}
        with database.transaction() as connection:
            for table in ("sessions", "events", "user_states"):
                assert (
                    connection.execute(
                        sql.SQL(
                            "SELECT count(*) AS n FROM {}.{} WHERE user_id=%s"
                        ).format(sql.Identifier(adk), sql.Identifier(table)),
                        (owner,),
                    ).fetchone()["n"]
                    == 0
                )
            connection.execute(
                "UPDATE sessions SET expires_at=clock_timestamp() "
                "WHERE id=ANY(%s::uuid[])",
                ([orphan, empty],),
            )
        result = RetentionService(database).compact()
        assert result["deletedSessions"] == 1
        with database.transaction() as connection:
            assert connection.execute(
                "SELECT id FROM sessions WHERE id=%s", (orphan,)
            ).fetchone()
            assert not connection.execute(
                "SELECT id FROM sessions WHERE id=%s", (empty,)
            ).fetchone()
    finally:
        with database.transaction() as connection:
            connection.execute("SELECT pg_advisory_xact_lock(724917,0)")
            connection.execute(
                sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(adk))
            )


def test_cleanup_cannot_target_original_evaluation_schemas():
    from types import SimpleNamespace

    for schema in ("workbench_live", f"test_{uuid4().hex}", "public"):
        with pytest.raises(DomainError, match="RETENTION_TARGET_DISABLED"):
            DeletionService(SimpleNamespace(schema=schema))
