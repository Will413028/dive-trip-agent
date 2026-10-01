import subprocess
from uuid import uuid4

import conftest
import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from test_chat_http import setup

from dive_trip.application.deletion import DeletionService
from dive_trip.application.sharing import SharingService
from dive_trip.application.trips import TripService
from dive_trip.bootstrap.hosted_recovery import RecoveryCoordinator
from dive_trip.bootstrap.hosted_recovery_file import RecoveryFiles, RecoveryStore
from dive_trip.bootstrap.hosted_storage import install_hosted_schema, recovery_snapshot
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError
from dive_trip.platform.migrations import migrate

pytestmark = pytest.mark.integration
KEY = "cd" * 32


def coordinator(database, tmp_path):
    tmp_path.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp_path.chmod(0o700)
    install_hosted_schema(database)
    store = RecoveryStore(tmp_path, KEY)
    result = RecoveryCoordinator(database, store)
    result.initialize()
    return result


def own_container(postgres):
    port = conninfo_to_dict(postgres)["port"]
    names = subprocess.run(
        [
            "docker",
            "ps",
            "--filter",
            "name=dive-python-test-",
            "--format",
            "{{.Names}}",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout.splitlines()
    matches = []
    for name in names:
        mapped = subprocess.run(
            ["docker", "port", name, "5432/tcp"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
        if mapped == f"127.0.0.1:{port}":
            matches.append(name)
    assert len(matches) == 1, "isolated fixture PostgreSQL identity required"
    return matches[0]


def test_missing_or_lost_copy_cannot_be_recreated(database, tmp_path):
    recovery = coordinator(database, tmp_path)
    recovery.require_serving()
    with pytest.raises(ValueError, match="RECOVERY_ALREADY_INITIALIZED"):
        recovery.initialize()
    (tmp_path / "recovery.json").unlink()
    with pytest.raises(ValueError, match="RECOVERY_MAINTENANCE"):
        recovery.require_serving()
    with pytest.raises(ValueError, match="RECOVERY_ALREADY_INITIALIZED"):
        recovery.initialize()


@pytest.mark.parametrize(
    "table",
    ["quota_reservations", "quota_daily_totals", "agent_invocations", "model_calls"],
)
def test_hosted_fixture_cannot_create_model_accounting(database, tmp_path, table):
    recovery = coordinator(database, tmp_path)
    with pytest.raises(Exception, match="HOSTED_FIXTURE_MODEL_ACCOUNTING_FORBIDDEN"):
        with database.transaction() as connection:
            connection.execute(
                sql.SQL("INSERT INTO {} DEFAULT VALUES").format(sql.Identifier(table))
            )
    recovery.require_serving()


def test_accounting_contamination_blocks_every_recovery_entry(database, tmp_path):
    recovery = coordinator(database, tmp_path)
    # Simulate a privileged import bypassing the fixture-only writer restriction.
    with database.transaction() as connection:
        connection.execute(
            "ALTER TABLE quota_daily_totals DISABLE TRIGGER hosted_no_model_accounting"
        )
        connection.execute(
            "INSERT INTO quota_daily_totals VALUES(current_date,1,123,1)"
        )
        connection.execute(
            "ALTER TABLE quota_daily_totals ENABLE TRIGGER hosted_no_model_accounting"
        )
    for action in (
        recovery.initialize,
        recovery.require_serving,
        recovery.export,
        recovery.prepare,
        recovery.reconcile,
        recovery.finish,
    ):
        with pytest.raises(
            ValueError, match="RECOVERY_FIXTURE_ONLY_ACCOUNTING_REQUIRED"
        ):
            action()
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT charged_cost_micros FROM quota_daily_totals"
        ).fetchone()
        assert row["charged_cost_micros"] == 123


def test_checkpoint_freezes_decisions_and_is_not_automatically_reusable(
    database, tmp_path
):
    recovery = coordinator(database, tmp_path)
    owner, _, trip, _ = setup(database)
    recovery.prepare()
    with pytest.raises(ValueError, match="RECOVERY_MAINTENANCE"):
        recovery.require_serving()
    with pytest.raises(Exception, match="HOSTED_RECOVERY_MAINTENANCE"):
        DeletionService(database).request(owner, trip.id)
    recovery.reconcile()
    recovery.finish()
    recovery.require_serving()
    with pytest.raises(ValueError, match="RECOVERY_FRESH_LIVE_CHECKPOINT_REQUIRED"):
        recovery.reconcile()


def test_prepare_write_failure_keeps_database_fenced(database, tmp_path, monkeypatch):
    recovery = coordinator(database, tmp_path)
    with monkeypatch.context() as patch:
        patch.setattr(
            RecoveryFiles,
            "write",
            lambda *_: (_ for _ in ()).throw(OSError("injected")),
        )
        with pytest.raises(OSError, match="injected"):
            recovery.prepare()
    with pytest.raises(ValueError, match="RECOVERY_MAINTENANCE"):
        recovery.require_serving()
    recovery.prepare()
    recovery.reconcile()
    recovery.finish()
    recovery.require_serving()


def test_reconcile_commit_then_copy_failure_is_idempotent(
    database, tmp_path, monkeypatch
):
    recovery = coordinator(database, tmp_path)
    owner, _, trip, _ = setup(database)
    recovery.prepare()
    with database.transaction() as connection:
        connection.execute(
            "UPDATE trips SET expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=%s",
            (trip.id,),
        )
    with monkeypatch.context() as patch:
        patch.setattr(
            RecoveryFiles,
            "write",
            lambda *_: (_ for _ in ()).throw(OSError("injected")),
        )
        with pytest.raises(OSError, match="injected"):
            recovery.reconcile()
    assert recovery_snapshot(database)["control"]["last_sequence"] == 1
    recovery.reconcile()
    recovery.reconcile()
    assert recovery_snapshot(database)["control"]["last_sequence"] == 1
    with pytest.raises(ValueError, match="RECOVERY_PURGE_PENDING"):
        recovery.finish()
    # Product-content unit boundary only; real Temporal purge is a separate gate.
    DeletionService(database).complete(trip.id)
    recovery.finish()
    recovery.require_serving()


def test_actual_dump_restore_does_not_revive_delete_or_revoke(
    database, postgres, tmp_path
):
    recovery = coordinator(database, tmp_path / "journal")
    owner, _, deleted_trip, planning = setup(database)
    retained_trip = TripService(database).create(owner, deleted_trip.snapshot)
    sharing = SharingService(database, planning.catalog)
    preview = sharing.preview(owner, retained_trip.id, 1)
    share = sharing.create(owner, retained_trip.id, 1, preview["previewHash"])
    container = own_container(postgres)
    dump = subprocess.run(
        [
            "docker",
            "exec",
            container,
            "pg_dump",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "--schema",
            database.schema,
            "--format=custom",
            "--no-owner",
            "--no-acl",
        ],
        capture_output=True,
        check=True,
        timeout=30,
    ).stdout
    DeletionService(database).request(owner, deleted_trip.id)
    sharing.revoke(owner, retained_trip.id, share["id"])
    recovery.export()
    recovery.prepare()
    database.close()
    with psycopg.connect(postgres, autocommit=True) as connection:
        connection.execute(
            sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(database.schema))
        )
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "pg_restore",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "--single-transaction",
            "--no-owner",
            "--no-acl",
        ],
        input=dump,
        capture_output=True,
        check=True,
        timeout=30,
    )
    restored = Database(postgres, database.schema)
    restored.open()
    try:
        restored_recovery = RecoveryCoordinator(restored, recovery.store)
        # Establish the negative: the old backup really contains visible content.
        assert TripService(restored).get(owner, deleted_trip.id).id == deleted_trip.id
        restored_sharing = SharingService(restored, planning.catalog)
        assert restored_sharing.read(share["token"])
        with pytest.raises(ValueError, match="RECOVERY_MAINTENANCE"):
            restored_recovery.require_serving()
        restored_recovery.reconcile()
        restored_recovery.reconcile()
        with pytest.raises(DomainError, match="NOT_FOUND"):
            TripService(restored).get(owner, deleted_trip.id)
        with pytest.raises(DomainError, match="NOT_FOUND"):
            restored_sharing.read(share["token"])
        assert recovery_snapshot(restored)["control"]["last_sequence"] == 2
        assert (
            TripService(restored).get(owner, retained_trip.id).snapshot
            == retained_trip.snapshot
        )
        with pytest.raises(ValueError, match="RECOVERY_PURGE_PENDING"):
            restored_recovery.finish()
        DeletionService(restored).complete(deleted_trip.id)
        restored_recovery.finish()
        restored_recovery.require_serving()
    finally:
        restored.close()


@pytest.fixture
def restart_database():
    # A restart must not invalidate the session fixture used by other cases.
    fixture = conftest.postgres.__wrapped__()
    postgres = next(fixture)
    schema = f"python_test_{uuid4().hex}"
    with psycopg.connect(postgres, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    database = Database(postgres, schema)
    try:
        database.open()
        migrate(database)
        yield database, postgres
    finally:
        database.close()
        fixture.close()


def test_unprepared_database_restart_stays_in_maintenance(restart_database, tmp_path):
    database, postgres = restart_database
    recovery = coordinator(database, tmp_path)
    recovery.require_serving()
    container = own_container(postgres)
    database.close()
    subprocess.run(
        ["docker", "restart", container],
        capture_output=True,
        check=True,
        timeout=30,
    )
    # Docker may assign a different ephemeral host port after restart.
    mapped = subprocess.run(
        ["docker", "port", container, "5432/tcp"],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout.strip()
    assert mapped.startswith("127.0.0.1:")
    restarted = Database(
        make_conninfo(postgres, port=mapped.removeprefix("127.0.0.1:")), database.schema
    )
    restarted.open()
    try:
        resumed = RecoveryCoordinator(restarted, recovery.store)
        with pytest.raises(ValueError, match="RECOVERY_HISTORY_DIVERGED"):
            resumed.require_serving()
        with pytest.raises(ValueError, match="RECOVERY_HISTORY_DIVERGED"):
            resumed.prepare()
        with pytest.raises(ValueError, match="RECOVERY_FRESH_LIVE_CHECKPOINT_REQUIRED"):
            resumed.reconcile()
    finally:
        restarted.close()
