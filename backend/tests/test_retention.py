from uuid import UUID, uuid4

import pytest
from deletion_helpers import DELETE_SERVER_ARGS, purge_eventually
from temporalio.testing import WorkflowEnvironment
from test_chat_http import setup

from dive_trip.application.deletion import DeletionWorker
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.retention import RetentionService
from dive_trip.modules.identity.public import Sessions
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


async def test_expired_owner_uses_durable_purge_before_session_removal(database):
    owner, _, trip, planning = setup(database)
    retention = RetentionService(database)
    async with await WorkflowEnvironment.start_local(
        dev_server_extra_args=DELETE_SERVER_ARGS
    ) as environment:
        dispatcher = FixtureDispatcher(planning, environment.client, f"idle-{uuid4()}")
        binding = await dispatcher.start(owner, trip.id, "expiry", "fixture:budget", 1)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' "
                "WHERE id=%s",
                (owner,),
            )
        assert retention.request_expired() == 1
        assert retention.request_expired() == 0
        assert retention.compact()["deletedSessions"] == 0
        with pytest.raises(DomainError, match="NOT_FOUND"):
            planning.begin_model(binding, "late")
        worker = DeletionWorker(retention.deletions, environment.client)
        await purge_eventually(worker, trip.id)
        assert (await worker.sweep())["prunedReceipts"] == 1
        assert retention.compact()["deletedSessions"] == 1
        with database.transaction() as connection:
            for table in ("sessions", "trips", "agent_runs", "trip_deletion_jobs"):
                assert (
                    connection.execute(f"SELECT count(*) AS n FROM {table}").fetchone()[
                        "n"
                    ]
                    == 0
                )


def test_compaction_preserves_unknown_charges_and_live_owner_receipts(database):
    live_owner, _ = Sessions(database).create()
    expired_owner, _ = Sessions(database).create()
    with database.transaction() as connection:
        connection.execute(
            "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=%s",
            (expired_owner,),
        )
        for owner, cost in (
            (expired_owner, None),
            (expired_owner, 100),
            (live_owner, None),
        ):
            connection.execute(
                "INSERT INTO quota_reservations("
                "id,owner_id,ip_key,request_id,payload_hash,"
                "day,reserved_at,expires_at,max_cost_micros,charged_cost_micros,"
                "actual_cost_micros,status,settled_at) VALUES(%s,%s,%s,%s,%s,"
                "(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date-31,"
                "clock_timestamp()-interval '31 days',"
                "clock_timestamp()-interval '30 days',400,%s,%s,'settled',"
                "clock_timestamp()-interval '30 days')",
                (
                    uuid4(),
                    owner,
                    "a" * 64,
                    str(uuid4()),
                    "b" * 64,
                    400 if cost is None else cost,
                    cost,
                ),
            )
    retention = RetentionService(database)
    assert retention.compact() == {"deletedSessions": 1, "compactedReceipts": 2}
    assert retention.compact() == {"deletedSessions": 0, "compactedReceipts": 0}
    with database.transaction() as connection:
        totals = connection.execute(
            "SELECT reservations,charged_cost_micros,unknown_usage "
            "FROM quota_daily_totals"
        ).fetchone()
        assert totals == {
            "reservations": 2,
            "charged_cost_micros": 500,
            "unknown_usage": 1,
        }
        assert connection.execute("SELECT owner_id FROM quota_reservations").fetchone()[
            "owner_id"
        ] == UUID(live_owner)
