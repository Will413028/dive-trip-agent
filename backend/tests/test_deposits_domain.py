import itertools

import pytest

from dive_trip.modules.deposits.domain import (
    CauseRule,
    DiverPayment,
    Mandate,
    RefundPolicy,
    SettlementFacts,
    check_mandate,
    owed_minor,
    settle,
    settle_diver,
)
from dive_trip.platform.errors import DomainError

POLICY = RefundPolicy(
    version=1,
    currency="USD",
    depositMinor=10000,
    tripDays=3,
    rules=[
        CauseRule(cause="weather", refundPercent=100),
        CauseRule(cause="operator", refundPercent=100),
    ],
)


def facts(days: list[int], cause: str = "weather") -> SettlementFacts:
    return SettlementFacts.model_validate(
        {"cause": cause, "cancelledDays": days, "evidenceIds": ["notice-1"]}
    )


def authorized(diver: str = "d1", amount: int = 10000) -> DiverPayment:
    return DiverPayment(
        diverId=diver,
        state="authorized",
        authorizedMinor=amount,
        capturedMinor=0,
        refundedMinor=0,
    )


def captured(diver: str = "d1", amount: int = 10000, refunded: int = 0) -> DiverPayment:
    return DiverPayment(
        diverId=diver,
        state="captured",
        authorizedMinor=amount,
        capturedMinor=amount,
        refundedMinor=refunded,
    )


def test_one_of_three_days_cancelled_partial_captures_the_rest() -> None:
    [result] = settle(POLICY, facts([2]), [authorized()])
    assert (result.action, result.amountMinor, result.returnedMinor) == (
        "partial_capture",
        6667,
        3333,
    )


def test_whole_trip_cancelled_voids_instead_of_capture_then_refund() -> None:
    [result] = settle(POLICY, facts([1, 2, 3]), [authorized()])
    assert (result.action, result.amountMinor, result.returnedMinor) == (
        "void",
        0,
        10000,
    )


def test_no_refund_rule_captures_in_full() -> None:
    policy = POLICY.model_copy(
        update={"rules": [CauseRule(cause="weather", refundPercent=0)]}
    )
    [result] = settle(policy, facts([1]), [authorized()])
    assert (result.action, result.amountMinor) == ("capture", 10000)


def test_after_capture_only_the_difference_is_refunded_once() -> None:
    [first] = settle(POLICY, facts([2]), [captured()])
    assert (first.action, first.amountMinor) == ("refund", 3333)
    [again] = settle(POLICY, facts([2]), [captured(refunded=3333)])
    assert (again.action, again.amountMinor) == ("none", 0)


def test_voided_payment_never_moves_money() -> None:
    voided = authorized().model_copy(update={"state": "voided"})
    [result] = settle(POLICY, facts([1, 2, 3]), [voided])
    assert (result.action, result.amountMinor, result.returnedMinor) == ("none", 0, 0)


@pytest.mark.parametrize(
    ("days", "cause", "code"),
    [
        ([4], "weather", "SETTLEMENT_DAYS_INVALID"),
        ([1, 1], "weather", "SETTLEMENT_DAYS_INVALID"),
    ],
)
def test_facts_outside_the_policy_are_rejected(
    days: list[int], cause: str, code: str
) -> None:
    with pytest.raises(DomainError) as error:
        owed_minor(POLICY, facts(days, cause))
    assert error.value.code == code


def test_cause_missing_from_policy_is_rejected() -> None:
    policy = POLICY.model_copy(
        update={"rules": [CauseRule(cause="weather", refundPercent=50)]}
    )
    with pytest.raises(DomainError) as error:
        owed_minor(policy, facts([1], "operator"))
    assert error.value.code == "SETTLEMENT_CAUSE_NOT_IN_POLICY"


def test_settlement_conserves_money_for_every_small_case() -> None:
    for trip_days, percent, deposit in itertools.product(
        range(1, 6), (0, 33, 50, 100), (1, 999, 10000)
    ):
        policy = RefundPolicy(
            version=1,
            currency="USD",
            depositMinor=deposit,
            tripDays=trip_days,
            rules=[CauseRule(cause="weather", refundPercent=percent)],
        )
        for count in range(1, trip_days + 1):
            owed = owed_minor(policy, facts(list(range(1, count + 1))))
            assert 0 <= owed <= deposit
            hold = settle_diver(authorized(amount=deposit), owed)
            assert hold.amountMinor + hold.returnedMinor == deposit
            paid = settle_diver(captured(amount=deposit), owed)
            assert (
                paid.owedMinor == owed
                and paid.owedMinor + paid.returnedMinor == deposit
            )


def test_duplicate_divers_are_rejected() -> None:
    with pytest.raises(DomainError):
        settle(POLICY, facts([1]), [authorized("a"), authorized("a")])


MANDATE = Mandate(
    autoMaxPerDiverMinor=5000,
    autoMaxPerBookingMinor=12000,
    allowedActions=["void", "partial_capture", "capture", "refund"],
    allowedCauses=["weather"],
    expiresOn="2026-12-31",
)


def test_small_weather_settlement_is_within_mandate() -> None:
    settlements = settle(POLICY, facts([2]), [authorized("a"), authorized("b")])
    assert check_mandate(MANDATE, facts([2]), settlements, "2026-11-01").withinMandate


def test_mandate_stops_large_or_unlisted_settlements() -> None:
    whole = settle(POLICY, facts([1, 2, 3]), [authorized("a"), authorized("b")])
    check = check_mandate(MANDATE, facts([1, 2, 3]), whole, "2027-01-01")
    assert not check.withinMandate
    assert set(check.reasons) == {
        "MANDATE_EXPIRED",
        "PER_DIVER_CAP_EXCEEDED",
        "PER_BOOKING_CAP_EXCEEDED",
    }
    operator = settle(POLICY, facts([2], "operator"), [authorized()])
    assert check_mandate(
        MANDATE, facts([2], "operator"), operator, "2026-11-01"
    ).reasons == ["CAUSE_NOT_ALLOWED"]
