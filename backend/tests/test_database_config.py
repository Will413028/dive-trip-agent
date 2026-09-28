import psycopg
import pytest

from dive_trip.platform.database import fixture_conninfo


@pytest.mark.integration
def test_local_database_ignores_ambient_identity_and_tls(postgres, monkeypatch):
    for name, value in {
        "PGPASSFILE": "/dev/null",
        "PGHOST": "must-not-use.invalid",
        "PGPORT": "1",
        "PGUSER": "must-not-use",
        "PGDATABASE": "must-not-use",
        "PGPASSWORD": "synthetic-ambient-value",
        "PGSSLMODE": "require",
        "PGOPTIONS": "-c default_transaction_read_only=on",
    }.items():
        monkeypatch.setenv(name, value)
    with psycopg.connect(postgres) as connection:
        assert connection.execute(
            "SELECT current_database(),current_user,inet_server_addr()::text"
        ).fetchone()[:2] == ("postgres", "postgres")
        assert connection.execute("SHOW default_transaction_read_only").fetchone() == (
            "off",
        )


@pytest.mark.parametrize("name", ["PGSERVICE", "PGSERVICEFILE"])
def test_service_discovery_is_rejected_before_libpq(name, monkeypatch):
    monkeypatch.setenv(name, "must-not-be-read")
    with pytest.raises(ValueError, match="AMBIENT_DATABASE_SERVICE_DISABLED"):
        fixture_conninfo(5432)


@pytest.mark.parametrize("port", [0, 65536, True, "5432"])
def test_local_connection_requires_an_explicit_valid_port(port):
    with pytest.raises(ValueError, match="INVALID_PORT"):
        fixture_conninfo(port)


def test_local_connection_cannot_select_an_unapproved_database():
    with pytest.raises(ValueError, match="DEDICATED_TEST_DATABASE_REQUIRED"):
        fixture_conninfo(5432, "live")
