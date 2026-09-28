from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from deletion_helpers import DELETE_SERVER_ARGS, purge_eventually
from fastapi.testclient import TestClient
from temporalio.api.enums.v1 import ArchivalState
from temporalio.service import RPCError, RPCStatusCode
from temporalio.testing import WorkflowEnvironment
from test_admission import setup as admitted_setup
from test_admission import start as admitted_start
from test_budget import snapshot
from test_chat_http import setup

from dive_trip.application.deletion import DeletionService, DeletionWorker
from dive_trip.application.dispatch import FixtureDispatcher
from dive_trip.application.sharing import SharingService
from dive_trip.application.trips import TripService
from dive_trip.bootstrap.api import create_app
from dive_trip.modules.identity.public import Sessions
from dive_trip.platform.errors import DomainError
from dive_trip.platform.workflow_lock import workflow_lock

pytestmark = pytest.mark.integration


async def test_delete_ack_keeps_content_until_execution_and_history_are_unreadable(
    database,
):
    owner, _, trip, planning = setup(database)
    planning.start(owner, trip.id, "delayed-delete", "fixture:budget", 1)
    service = DeletionService(database)
    service.request(owner, trip.id)
    missing = RPCError("missing", RPCStatusCode.NOT_FOUND, b"")
    handle = SimpleNamespace(
        describe=AsyncMock(return_value=object()),
        fetch_history=AsyncMock(return_value=object()),
    )
    client = SimpleNamespace(
        namespace="default",
        workflow_service=SimpleNamespace(
            describe_namespace=AsyncMock(
                return_value=SimpleNamespace(
                    config=SimpleNamespace(
                        history_archival_state=ArchivalState.ARCHIVAL_STATE_DISABLED,
                        visibility_archival_state=ArchivalState.ARCHIVAL_STATE_DISABLED,
                    )
                )
            ),
            delete_workflow_execution=AsyncMock(),
        ),
        get_workflow_handle=lambda _: handle,
    )
    worker = DeletionWorker(service, client)
    for execution_missing in (False, True):
        handle.describe.side_effect = missing if execution_missing else None
        with pytest.raises(DomainError, match="DELETION_PENDING"):
            await worker.purge(trip.id)
        assert service.status(owner, trip.id) == {"status": "deleting"}
        with database.transaction() as connection:
            assert connection.execute("SELECT id FROM trips").fetchone() is not None
    handle.fetch_history.side_effect = missing
    await worker.purge(trip.id)
    assert service.status(owner, trip.id) == {"status": "deleted"}


async def test_deletion_fences_access_and_recovers_lost_history_delete_ack(database):
    owner, token, trip, planning = setup(database)
    sharing = SharingService(database, planning.catalog)
    preview = sharing.preview(owner, trip.id, 1)
    share = sharing.create(owner, trip.id, 1, preview["previewHash"])
    service = DeletionService(database)
    async with await WorkflowEnvironment.start_local(
        dev_server_extra_args=DELETE_SERVER_ARGS
    ) as environment:
        dispatcher = FixtureDispatcher(
            planning, environment.client, f"unpolled-{uuid4()}"
        )
        binding = await dispatcher.start(owner, trip.id, "start", "fixture", 1)
        handle = environment.client.get_workflow_handle(f"dive-trip-v1:{binding.runId}")
        assert (await handle.describe()).id == f"dive-trip-v1:{binding.runId}"
        assert service.request(owner, trip.id) == {"status": "deleting"}
        assert service.request(owner, trip.id) == {"status": "deleting"}
        with pytest.raises(DomainError, match="NOT_FOUND"):
            TripService(database).get(owner, trip.id)
        with pytest.raises(DomainError, match="NOT_FOUND"):
            sharing.read(share["token"])
        with pytest.raises(DomainError, match="NOT_FOUND"):
            planning.begin_model(binding, "late")
        with pytest.raises(DomainError, match="NOT_FOUND"):
            await dispatcher.start(owner, trip.id, "start", "fixture", 1)

        async def lose_ack(*args, **kwargs):
            await environment.client.workflow_service.delete_workflow_execution(
                *args, **kwargs
            )
            raise RPCError("injected lost ACK", RPCStatusCode.UNAVAILABLE, b"")

        lossy = SimpleNamespace(
            namespace=environment.client.namespace,
            workflow_service=SimpleNamespace(
                delete_workflow_execution=lose_ack,
                describe_namespace=environment.client.workflow_service.describe_namespace,
            ),
        )
        with pytest.raises(RPCError):
            await DeletionWorker(service, lossy).purge(trip.id)
        assert service.status(owner, trip.id) == {"status": "deleting"}
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT count(*) AS n FROM trips").fetchone()["n"]
                == 1
            )
        # A new process has only the persisted job. Repeating the delete is safe.
        restarted = DeletionWorker(DeletionService(database), environment.client)
        await purge_eventually(restarted, trip.id)
        assert service.status(owner, trip.id) == {"status": "deleted"}
        assert service.request(owner, trip.id) == {"status": "deleted"}
        with pytest.raises(RPCError) as missing:
            await handle.fetch_history()
        assert missing.value.status == RPCStatusCode.NOT_FOUND
        with database.transaction() as connection:
            for table in (
                "trips",
                "trip_versions",
                "agent_runs",
                "trip_shares",
                "planning_executions",
            ):
                assert (
                    connection.execute(f"SELECT count(*) AS n FROM {table}").fetchone()[
                        "n"
                    ]
                    == 0
                )
            assert (
                connection.execute(
                    "SELECT workflow_ids FROM trip_deletion_jobs"
                ).fetchone()["workflow_ids"]
                == []
            )
            connection.execute(
                "UPDATE trip_deletion_jobs SET next_attempt_at=clock_timestamp()"
            )
        assert service.prune_receipts() == 0
        pending = TripService(database).create(owner, snapshot())
        service.request(owner, pending.id)
        with database.transaction() as connection:
            connection.execute("UPDATE sessions SET expires_at=clock_timestamp()")
            connection.execute(
                "UPDATE trip_deletion_jobs SET next_attempt_at=clock_timestamp()"
            )
        assert service.prune_receipts() == 1
        assert service.job(pending.id)["status"] == "deleting"


async def test_purge_waits_for_inflight_start_rpc_and_keeps_quota_unknown(database):
    owner, trip, admission, catalog = admitted_setup(database)
    binding, invocation, _ = admitted_start(admission, owner, trip)
    admission.account(binding, str(invocation["id"]), "model-1")
    service = DeletionService(database)
    service.request(owner, trip.id)
    async with await WorkflowEnvironment.start_local(
        dev_server_extra_args=DELETE_SERVER_ARGS
    ) as environment:
        worker = DeletionWorker(service, environment.client)
        async with workflow_lock(database, f"dive-trip-v1:{binding.runId}"):
            with pytest.raises(DomainError, match="WORKFLOW_RPC_BUSY"):
                await worker.purge(trip.id)
            assert service.status(owner, trip.id) == {"status": "deleting"}
        await purge_eventually(worker, trip.id)
        with database.transaction() as connection:
            row = connection.execute("SELECT * FROM quota_reservations").fetchone()
            assert row["charged_cost_micros"] == 50
            assert row["actual_cost_micros"] is None
            assert row["status"] == "settled"
            assert (
                connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()[
                    "n"
                ]
                == 0
            )


def test_delete_http_reports_pending_then_complete_and_rejects_other_owner(database):
    owner, token, trip, planning = setup(database)
    service = DeletionService(database)
    app = create_app(database, planning.catalog, "http://testserver")
    with TestClient(app, headers={"Origin": "http://testserver"}) as client:
        client.cookies.set("dive_trip_session", token)
        response = client.request("DELETE", f"/api/trips/{trip.id}", json={})
        assert response.status_code == 202
        assert response.json() == {"status": "deleting"}
        assert client.get(f"/api/trips/{trip.id}").status_code == 404
        assert client.get(f"/api/trips/{trip.id}/deletion").json() == {
            "status": "deleting"
        }
        stranger, stranger_token = Sessions(database).create()
        client.cookies.set("dive_trip_session", stranger_token)
        assert client.get(f"/api/trips/{trip.id}/deletion").status_code == 404
        assert (
            client.request("DELETE", f"/api/trips/{trip.id}", json={}).status_code
            == 404
        )
        assert service.status(owner, trip.id) == {"status": "deleting"}
