from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from test_trip_transactions import owner

from dive_trip.application.quota import Quota
from dive_trip.modules.usage.public import AdmissionClock, Policy, Reserve
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def policy(budget=100):
    return Policy(
        enabled=True,
        dailyBudgetMicros=budget,
        priceBasis="synthetic",
        reservationTtlMs=60000,
    )


def request(identity, *, cost=50, key="first", run=None):
    return Reserve(
        ownerId=identity,
        ipKey="a" * 64,
        requestId=key,
        payloadHash="b" * 64,
        logicalRunId=run,
        maxCostMicros=cost,
        now=datetime.now(UTC),
    )


def test_unknown_settlement_keeps_cost_and_cannot_be_rewritten(database):
    quota = Quota(database)
    identity = owner(database)
    value = request(identity)
    reserved, created = quota.reserve(value, policy())
    assert created
    settled = quota.settle(reserved.reservationId, None, datetime.now(UTC))
    assert settled.chargedCostMicros == 50
    assert settled.actualCostMicros is None
    assert quota.settle(reserved.reservationId, None, datetime.now(UTC)) == settled
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        quota.settle(reserved.reservationId, 0, datetime.now(UTC))
    replay, created = quota.reserve(value, policy())
    assert not created
    assert replay == settled


def test_zero_cost_confirmation_survives_exhausted_budget_but_not_capacity(database):
    quota = Quota(database)
    identity = owner(database)
    run = str(uuid4())
    start, _ = quota.reserve(request(identity, cost=100, run=run), policy())
    quota.settle(start.reservationId, 100, datetime.now(UTC))
    with pytest.raises(DomainError, match="QUOTA_BUDGET"):
        quota.reserve(request(identity, key="new-run", cost=1), policy())
    resume, created = quota.reserve(
        request(identity, key="resume", cost=0, run=run), policy()
    )
    assert created
    assert resume.chargedCostMicros == 0
    quota.reserve(request(identity, key="zero-2", cost=0), policy())
    quota.reserve(request(identity, key="zero-3", cost=0), policy())
    with pytest.raises(DomainError, match="QUOTA_CONCURRENCY"):
        quota.reserve(request(identity, key="zero-4", cost=0), policy())


def test_idempotency_binds_cost_payload_and_logical_run(database):
    quota = Quota(database)
    identity = owner(database)
    value = request(identity, run=str(uuid4()))
    quota.reserve(value, policy())
    for update in [
        {"maxCostMicros": 0},
        {"payloadHash": "c" * 64},
        {"logicalRunId": str(uuid4())},
    ]:
        with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
            quota.reserve(value.model_copy(update=update), policy())


def test_monotonic_wait_consumes_deadline_and_midnight_rejects():
    start = datetime(2026, 9, 28, 15, 59, 59, tzinfo=UTC)
    clock = AdmissionClock(start, 0, lambda: 2)
    with pytest.raises(DomainError, match="QUOTA_CLOCK_CHANGED"):
        clock.check(start + timedelta(seconds=10))
    with pytest.raises(DomainError, match="QUOTA_RESERVATION_EXPIRED"):
        clock.check(start + timedelta(seconds=1))
