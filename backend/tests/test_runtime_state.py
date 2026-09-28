import pytest
from temporalio.testing import WorkflowEnvironment
from test_chat_http import setup

from dive_trip.application.runtime_binding import bind_temporal
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


async def test_product_database_requires_original_persistent_temporal_service(
    database, tmp_path
):
    filename = str(tmp_path / "temporal.sqlite")
    async with await WorkflowEnvironment.start_local(
        dev_server_database_filename=filename
    ) as first:
        await bind_temporal(database, first.client)
    async with await WorkflowEnvironment.start_local(
        dev_server_database_filename=filename
    ) as restarted:
        await bind_temporal(database, restarted.client)
    async with await WorkflowEnvironment.start_local() as empty:
        with pytest.raises(DomainError, match="TEMPORAL_SERVICE_MISMATCH"):
            await bind_temporal(database, empty.client)


async def test_existing_execution_cannot_be_rebound_as_a_fresh_runtime(database):
    owner, _, trip, service = setup(database)
    service.start(owner, trip.id, "previous", "fixture", 1)
    async with await WorkflowEnvironment.start_local() as empty:
        with pytest.raises(
            DomainError, match="TEMPORAL_BINDING_REQUIRED_BEFORE_EXECUTION"
        ):
            await bind_temporal(database, empty.client)
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT * FROM temporal_service_binding").fetchall()
            == []
        )
