"""Deterministic deposit settlement: the policy computes every amount, never the model.

Amounts are USD minor units (cents). A refund policy version is immutable once a
booking uses it; settlement facts (cause, cancelled days, evidence) are the only
model-supplied input.
"""

from typing import Annotated, Literal

from pydantic import Field

from dive_trip.platform.schema import (
    CalendarDate,
    Nonempty,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)

from .errors import DepositConflict

Cause = Literal["weather", "operator"]
Action = Literal["void", "partial_capture", "capture", "refund", "none"]
Percent = Annotated[NonnegativeInt, Field(le=100)]


class CauseRule(WireModel):
    cause: Cause
    # Percent of each cancelled day's share of the deposit that is returned.
    refundPercent: Percent


class RefundPolicy(WireModel):
    version: PositiveInt
    currency: Literal["USD"]
    depositMinor: PositiveInt
    tripDays: Annotated[PositiveInt, Field(le=14)]
    rules: Annotated[list[CauseRule], Field(min_length=1, max_length=4)]


class Mandate(WireModel):
    """What the agent may execute alone; caps apply to money moved back to divers."""

    autoMaxPerDiverMinor: NonnegativeInt
    autoMaxPerBookingMinor: NonnegativeInt
    allowedActions: Annotated[list[Action], Field(max_length=5)]
    allowedCauses: Annotated[list[Cause], Field(max_length=2)]
    expiresOn: CalendarDate


class SettlementFacts(WireModel):
    cause: Cause
    cancelledDays: Annotated[list[PositiveInt], Field(min_length=1, max_length=14)]
    evidenceIds: Annotated[list[Nonempty], Field(min_length=1, max_length=16)]


class DiverPayment(WireModel):
    diverId: Nonempty
    state: Literal["authorized", "captured", "voided"]
    authorizedMinor: NonnegativeInt
    capturedMinor: NonnegativeInt
    refundedMinor: NonnegativeInt


class DiverSettlement(WireModel):
    diverId: str
    action: Action
    amountMinor: NonnegativeInt  # amount captured or refunded by this action
    owedMinor: NonnegativeInt  # what the diver ends up paying in total
    returnedMinor: (
        NonnegativeInt  # money released or refunded to the diver by this action
    )


class MandateCheck(WireModel):
    withinMandate: bool
    reasons: list[str]


def rule_for(policy: RefundPolicy, cause: Cause) -> CauseRule:
    for rule in policy.rules:
        if rule.cause == cause:
            return rule
    raise DepositConflict("SETTLEMENT_CAUSE_NOT_IN_POLICY")


def validate_facts(policy: RefundPolicy, facts: SettlementFacts) -> None:
    rule_for(policy, facts.cause)
    days = facts.cancelledDays
    if len(set(days)) != len(days) or any(day > policy.tripDays for day in days):
        raise DepositConflict("SETTLEMENT_DAYS_INVALID")
    if len(set(facts.evidenceIds)) != len(facts.evidenceIds):
        raise DepositConflict("SETTLEMENT_EVIDENCE_DUPLICATED")


def owed_minor(policy: RefundPolicy, facts: SettlementFacts) -> int:
    """What each diver pays: deposit minus the policy refund for the cancelled days."""
    validate_facts(policy, facts)
    percent = rule_for(policy, facts.cause).refundPercent
    refund = (policy.depositMinor * len(facts.cancelledDays) * percent) // (
        policy.tripDays * 100
    )
    return policy.depositMinor - refund


def settle_diver(payment: DiverPayment, owed: int) -> DiverSettlement:
    """Pick the PayPal action; never capture then refund if a void would do."""
    if payment.state == "voided":
        return DiverSettlement(
            diverId=payment.diverId,
            action="none",
            amountMinor=0,
            owedMinor=0,
            returnedMinor=0,
        )
    if payment.state == "authorized":
        if owed > payment.authorizedMinor:
            raise DepositConflict("SETTLEMENT_EXCEEDS_AUTHORIZATION")
        if owed == 0:
            action: Action = "void"
        elif owed < payment.authorizedMinor:
            action = "partial_capture"
        else:
            action = "capture"
        return DiverSettlement(
            diverId=payment.diverId,
            action=action,
            amountMinor=owed,
            owedMinor=owed,
            returnedMinor=payment.authorizedMinor - owed,
        )
    net = payment.capturedMinor - payment.refundedMinor
    refund = max(net - owed, 0)
    return DiverSettlement(
        diverId=payment.diverId,
        action="refund" if refund else "none",
        amountMinor=refund,
        owedMinor=net - refund,
        returnedMinor=refund,
    )


def settle(
    policy: RefundPolicy, facts: SettlementFacts, payments: list[DiverPayment]
) -> list[DiverSettlement]:
    if len({p.diverId for p in payments}) != len(payments):
        raise DepositConflict("SETTLEMENT_DIVER_DUPLICATED")
    owed = owed_minor(policy, facts)
    return [settle_diver(payment, owed) for payment in payments]


def check_mandate(
    mandate: Mandate,
    facts: SettlementFacts,
    settlements: list[DiverSettlement],
    today: str,
) -> MandateCheck:
    reasons = []
    if today > mandate.expiresOn:
        reasons.append("MANDATE_EXPIRED")
    if facts.cause not in mandate.allowedCauses:
        reasons.append("CAUSE_NOT_ALLOWED")
    moving = [s for s in settlements if s.action != "none"]
    if any(s.action not in mandate.allowedActions for s in moving):
        reasons.append("ACTION_NOT_ALLOWED")
    if any(s.returnedMinor > mandate.autoMaxPerDiverMinor for s in moving):
        reasons.append("PER_DIVER_CAP_EXCEEDED")
    if sum(s.returnedMinor for s in moving) > mandate.autoMaxPerBookingMinor:
        reasons.append("PER_BOOKING_CAP_EXCEEDED")
    return MandateCheck(withinMandate=not reasons, reasons=reasons)
