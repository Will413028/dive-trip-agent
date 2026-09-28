import pytest

from dive_trip.platform.errors import DomainError
from dive_trip.platform.migrations import MIGRATIONS, migrate, require_current

pytestmark = pytest.mark.integration


def test_migrations_are_idempotent_and_never_rewrite_applied_history(database):
    require_current(database)
    with database.transaction() as connection:
        original = connection.execute(
            "SELECT * FROM schema_migrations ORDER BY id"
        ).fetchall()
    migrate(database)
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT * FROM schema_migrations ORDER BY id").fetchall()
            == original
        )
        assert len(original) == len(MIGRATIONS)
        connection.execute(
            "UPDATE schema_migrations SET checksum='modified' WHERE id='001-core'"
        )
    with pytest.raises(DomainError, match="MIGRATION_CHECKSUM_MISMATCH"):
        migrate(database)
    with pytest.raises(DomainError, match="MIGRATIONS_REQUIRED"):
        require_current(database)
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT checksum FROM schema_migrations WHERE id='001-core'"
            ).fetchone()["checksum"]
            == "modified"
        )


def test_unknown_migration_is_not_silently_adopted(database):
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO schema_migrations(id,checksum) VALUES('unknown','untouched')"
        )
    with pytest.raises(DomainError, match="UNKNOWN_MIGRATION"):
        migrate(database)
    with pytest.raises(DomainError, match="MIGRATIONS_REQUIRED"):
        require_current(database)
