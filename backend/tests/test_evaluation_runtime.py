import asyncio
from uuid import uuid4

import httpx
import pytest
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.testing import WorkflowEnvironment
from test_chat_http import ORIGIN, check_web_consumer, events, setup, start_body
from test_quota import policy

from dive_trip.application import evaluation_runtime
from dive_trip.application.admission import AdmissionService
from dive_trip.application.agent_runtime import SyntheticGeneration
from dive_trip.application.evaluation_runtime import EvaluationDispatcher
from dive_trip.application.planning import PlanningService
from dive_trip.application.run_queries import RunQueries
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.trips import TripService
from dive_trip.bootstrap.api import create_app
from dive_trip.modules.usage.provider import GEMINI_MODEL, ProviderBinding
from dive_trip.platform.errors import DomainError
from dive_trip.platform.evaluation_peer import EvaluationLoopbackPeer


class Generation(SyntheticGeneration):
    def __init__(self, provider):
        super().__init__(provider, "synthetic-not-a-real-key")
        self.closed = False

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("close_timeout", [False, True])
async def test_cancel_failure_cannot_skip_untransferred_generation_close(
    database, monkeypatch, close_timeout
):
    owner, _, trip, fixture = setup(database)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(
        database, fixture.catalog, accounting=RuntimeAccounting(provider)
    )
    generation = Generation(
        ProviderBinding(provider="openrouter", model="vendor/model:free")
    )

    async def load():
        return generation

    async def broken_cancel(_binding):
        raise DomainError("CANCEL_FAILED")

    attempted = asyncio.Event()
    if close_timeout:

        async def slow_close():
            attempted.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(generation, "aclose", slow_close)
        monkeypatch.setattr(evaluation_runtime, "SDK_CLOSE_SECONDS", 0.01)

    dispatcher = EvaluationDispatcher(
        service,
        AdmissionService(database, fixture.catalog),
        None,
        "not-started",
        policy=policy(10000000),
        peer=EvaluationLoopbackPeer(b"a" * 32),
        load_generation=load,
    )
    monkeypatch.setattr(dispatcher, "cancel", broken_cancel)
    with pytest.raises(TimeoutError if close_timeout else DomainError):
        await dispatcher.start(owner, trip.id, str(uuid4()), "synthetic", 1)
    assert attempted.is_set() if close_timeout else generation.closed
    with pytest.raises(DomainError, match="EVALUATION_DRAIN_UNVERIFIED"):
        await dispatcher.join()


async def test_concurrent_start_cannot_admit_while_previous_generation_is_loading(
    database, monkeypatch
):
    owner, _, trip, fixture = setup(database)
    other = TripService(database).create(owner, trip.snapshot)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(
        database, fixture.catalog, accounting=RuntimeAccounting(provider)
    )
    admission = AdmissionService(database, fixture.catalog)
    loading, second_admission = asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    calls = 0
    original = admission.start

    def admit(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            loop.call_soon_threadsafe(second_admission.set)
        return original(*args, **kwargs)

    async def load():
        loading.set()
        await asyncio.Event().wait()
        pytest.fail("test cancels before generation creation")

    async def fence(binding):
        service.recover(binding, interrupted=True)

    monkeypatch.setattr(admission, "start", admit)
    dispatcher = EvaluationDispatcher(
        service,
        admission,
        None,
        "not-started",
        policy=policy(10000000),
        peer=EvaluationLoopbackPeer(b"a" * 32),
        load_generation=load,
    )
    monkeypatch.setattr(dispatcher, "cancel", fence)
    first = asyncio.create_task(
        dispatcher.start(owner, trip.id, str(uuid4()), "synthetic", 1)
    )
    async with asyncio.timeout(10):
        await loading.wait()
    second = asyncio.create_task(
        dispatcher.start(owner, other.id, str(uuid4()), "synthetic", 1)
    )
    witness = asyncio.create_task(second_admission.wait())
    try:
        done, _ = await asyncio.wait({witness}, timeout=1)
        assert not done, (
            "a second start entered admission while the first owned its phase"
        )
        assert calls == 1
    finally:
        for task in (first, second, witness):
            task.cancel()
        await asyncio.gather(first, second, witness, return_exceptions=True)


@pytest.mark.parametrize("accepted", [True, False])
async def test_owned_worker_http_phases_admit_before_load_and_join_before_capture(
    database, accepted
):
    owner, token, trip, fixture = setup(database)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(
        database, fixture.catalog, accounting=RuntimeAccounting(provider)
    )
    generations = []

    async def load():
        with database.transaction() as connection:
            assert (
                connection.execute(
                    "SELECT count(*) AS n FROM agent_invocations"
                ).fetchone()["n"]
                == 1
            )
            assert (
                connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()[
                    "n"
                ]
                == 0
            )
        value = Generation(provider)
        generations.append(value)
        return value

    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        dispatcher = EvaluationDispatcher(
            service,
            AdmissionService(database, fixture.catalog),
            environment.client,
            f"eval-http-{uuid4().hex}",
            policy=policy(10000000),
            peer=EvaluationLoopbackPeer(b"a" * 32),
            load_generation=load,
        )
        app = create_app(database, fixture.catalog, ORIGIN, dispatcher=dispatcher)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
            cookies={"dive_trip_session": token},
        ) as client:
            url = f"/api/trips/{trip.id}"
            body = start_body(trip.id)
            response = await client.post(f"{url}/agent", json=body)
            assert check_web_consumer(response, trip.id, body["runId"]) == events(
                response
            )
            run = (await client.get(f"{url}/runs")).json()["runs"][0]
            binding = RunQueries(database).binding(owner, trip.id, run["id"])
            before, checkpoint, audit = await dispatcher.capture(binding)
            assert audit.complete and checkpoint.terminal == "awaiting_confirmation"
            assert len(generations) == 1 and generations[0].closed

            async def forbidden():
                pytest.fail("resume must not request generation")

            dispatcher.load_generation = forbidden
            confirm = {
                **body,
                "runId": str(uuid4()),
                "messages": [],
                "forwardedProps": {"runId": run["id"]},
                "resume": [
                    {
                        "interruptId": run["interruptId"],
                        "status": "resolved",
                        "payload": {"confirmed": accepted},
                    }
                ],
            }
            response = await client.post(f"{url}/agent", json=confirm)
            assert check_web_consumer(response, trip.id, confirm["runId"]) == events(
                response
            )
            after, completed, audit = await dispatcher.capture(binding)
            assert audit.complete and completed.terminal == "completed"
            assert after.calls == before.calls
            assert audit.decisionReceipt.status == (
                "applied" if accepted else "rejected"
            )
            assert len(generations) == 1


async def test_cancellation_during_generation_loading_retains_claim_and_unknown(
    database,
):
    owner, token, trip, fixture = setup(database)
    provider = ProviderBinding(provider="gemini", model=GEMINI_MODEL)
    service = PlanningService(
        database, fixture.catalog, accounting=RuntimeAccounting(provider)
    )
    loading = asyncio.Event()

    async def load():
        loading.set()
        await asyncio.Event().wait()
        pytest.fail("must cancel before creating SDK")

    async with await WorkflowEnvironment.start_local(
        plugins=[PydanticAIPlugin()]
    ) as environment:
        dispatcher = EvaluationDispatcher(
            service,
            AdmissionService(database, fixture.catalog),
            environment.client,
            f"eval-cancel-{uuid4().hex}",
            policy=policy(10000000),
            peer=EvaluationLoopbackPeer(b"a" * 32),
            load_generation=load,
        )
        app = create_app(database, fixture.catalog, ORIGIN, dispatcher=dispatcher)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
            cookies={"dive_trip_session": token},
        ) as client:
            request = asyncio.create_task(
                client.post(f"/api/trips/{trip.id}/agent", json=start_body(trip.id))
            )
            async with asyncio.timeout(10):
                await loading.wait()
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
        with database.transaction() as connection:
            assert (
                connection.execute("SELECT status FROM agent_runs").fetchone()["status"]
                == "interrupted"
            )
            quota = connection.execute(
                "SELECT status,actual_cost_micros,charged_cost_micros "
                "FROM quota_reservations"
            ).fetchone()
            assert quota["status"] == "settled" and quota["actual_cost_micros"] is None
            assert quota["charged_cost_micros"] > 0
            assert (
                connection.execute("SELECT count(*) AS n FROM model_calls").fetchone()[
                    "n"
                ]
                == 0
            )
