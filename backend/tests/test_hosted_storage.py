from uuid import uuid4

import pytest

from dive_trip.bootstrap.hosted_storage import (
    HostedIngressStore,
    HostedLimits,
    install_hosted_schema,
    recovery_snapshot,
    require_hosted_schema,
)

pytestmark = pytest.mark.integration


def test_install_and_admission(database):
    install_hosted_schema(database)
    install_hosted_schema(database)
    require_hosted_schema(database)
    store = HostedIngressStore(database)
    nonce = uuid4().hex
    assert store.consume(nonce, "a" * 64) == 200
    assert store.consume(nonce, "b" * 64) == 409
    # Saturate this and adjacent windows without depending on wall-clock rollover.
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO hosted_ip_windows(client_hash,minute,count) "
            "SELECT %s,floor(extract(epoch FROM clock_timestamp())/60)+n,60 "
            "FROM generate_series(-1,1) n "
            "ON CONFLICT(client_hash,minute) DO UPDATE SET count=60",
            ("a" * 64,),
        )
    assert store.consume(uuid4().hex, "a" * 64) == 429
    assert store.consume(uuid4().hex, "b" * 64) == 200
    snapshot = recovery_snapshot(database)
    assert snapshot["control"]["last_sequence"] == 0
    assert snapshot["records"] == []


def test_existing_product_data_cannot_be_repurposed(database):
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
            (uuid4(), "a" * 64),
        )
    with pytest.raises(ValueError, match="HOSTED_EMPTY_DATABASE_REQUIRED"):
        install_hosted_schema(database)
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM sessions").fetchone()["n"]
            == 1
        )


def test_session_capacity_is_enforced(database):
    install_hosted_schema(database)
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO sessions(id,token_hash) "
            "SELECT gen_random_uuid(),lpad(to_hex(n),64,'0') "
            "FROM generate_series(1,1000) n"
        )
    with pytest.raises(Exception, match="HOSTED_CAPACITY_REACHED"):
        with database.transaction() as connection:
            connection.execute(
                "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
                (uuid4(), "f" * 64),
            )


def test_recovery_snapshot_rejects_missing_decisions(database):
    install_hosted_schema(database)
    with database.transaction() as connection:
        connection.execute("UPDATE hosted_control SET last_sequence=1")
    with pytest.raises(ValueError, match="HOSTED_RECOVERY_HISTORY_INCOMPLETE"):
        recovery_snapshot(database)


def test_delete_journal_is_atomic_and_survives_content_purge(database):
    install_hosted_schema(database)
    owner, trip = uuid4(), uuid4()
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)", (owner, "a" * 64)
        )
        connection.execute(
            "INSERT INTO trips(id,owner_id,current_version) VALUES(%s,%s,1)",
            (trip, owner),
        )
        connection.execute(
            "INSERT INTO trip_versions(trip_id,version,snapshot) VALUES(%s,1,'{}')",
            (trip,),
        )
    with pytest.raises(RuntimeError, match="rollback"):
        with database.transaction() as connection:
            connection.execute(
                "UPDATE trips SET deletion_requested_at=clock_timestamp() WHERE id=%s",
                (trip,),
            )
            raise RuntimeError("rollback")
    assert recovery_snapshot(database)["control"]["last_sequence"] == 0
    with database.transaction() as connection:
        connection.execute(
            "UPDATE trips SET deletion_requested_at=clock_timestamp() WHERE id=%s",
            (trip,),
        )
    with database.transaction() as connection:
        connection.execute("DELETE FROM sessions WHERE id=%s", (owner,))
    snapshot = recovery_snapshot(database)
    assert snapshot["control"]["last_sequence"] == 1
    assert snapshot["records"][0]["trip_id"] == trip
    assert snapshot["records"][0]["kind"] == "delete-trip"
    with pytest.raises(Exception, match="HOSTED_RECOVERY_IMMUTABLE"):
        with database.transaction() as connection:
            connection.execute("DELETE FROM hosted_recovery_journal")


def test_published_limits_are_shared_and_global_denial_does_not_store_nonces(database):
    install_hosted_schema(database, HostedLimits(1, 1, 2, 2, 1))
    store = HostedIngressStore(database)
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO hosted_ip_windows(client_hash,minute,count) "
            "SELECT 'global',floor(extract(epoch FROM clock_timestamp())/60)+n,1 "
            "FROM generate_series(-1,1) n"
        )
    assert store.consume(uuid4().hex, "a" * 64) == 429
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM hosted_ingress_nonces"
            ).fetchone()["n"]
            == 0
        )
        for number in range(2):
            connection.execute(
                "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
                (uuid4(), str(number) * 64),
            )
    with pytest.raises(Exception, match="HOSTED_CAPACITY_REACHED"):
        with database.transaction() as connection:
            connection.execute(
                "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
                (uuid4(), "f" * 64),
            )
    install_hosted_schema(database, HostedLimits(2, 1, 3, 2, 1))
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
            (uuid4(), "f" * 64),
        )


def test_hosted_migration_history_cannot_drift(database):
    install_hosted_schema(database)
    with database.transaction() as connection:
        connection.execute("UPDATE hosted_migrations SET checksum=%s", ("0" * 64,))
    with pytest.raises(ValueError, match="HOSTED_SCHEMA_CHECKSUM_MISMATCH"):
        install_hosted_schema(database)
    with pytest.raises(ValueError, match="HOSTED_SCHEMA_MIGRATION_REQUIRED"):
        require_hosted_schema(database)
