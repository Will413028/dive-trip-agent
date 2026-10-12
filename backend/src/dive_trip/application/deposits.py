"""Group deposits use cases and the per-booking Temporal workflow.

The workflow only waits and decides when to act; activities do the database and PayPal
work. An assessment proposes a settlement from the evidence: the agent's facts when an
assessor is configured, otherwise the deterministic rules ("No AI"). Only an agent
proposal that agrees with the rules and fits the organizer's mandate executes without
approval.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from dive_trip.modules.deposits import service
    from dive_trip.modules.deposits import transactions as tx
    from dive_trip.modules.deposits.domain import (
        Mandate,
        RefundPolicy,
        SettlementFacts,
        check_mandate,
        settle,
    )
    from dive_trip.modules.deposits.paypal import PayPalClient, SandboxCard
    from dive_trip.modules.deposits.rules import agrees, rule_facts
    from dive_trip.platform.database import Database
    from dive_trip.platform.errors import DomainError

# (booking row, evidence rows) -> agent facts, or None when the agent finds no cause.
Assessor = Callable[
    [dict[str, Any], list[dict[str, Any]]], Awaitable[SettlementFacts | None]
]

SEED_NAMES = ("Aiko (Osaka)", "Mateo (Madrid)", "Priya (Singapore)", "Lena (Berlin)")


@dataclass
class DepositsContext:
    database: Database
    paypal: PayPalClient
    seed_card: SandboxCard
    assessor: Assessor | None = None


_context: DepositsContext | None = None


def bind_deposits(context: DepositsContext | None) -> None:
    global _context
    _context = context


def context() -> DepositsContext:
    if _context is None:
        raise DomainError("DEPOSITS_NOT_CONFIGURED")
    return _context


async def create_booking(
    ctx: DepositsContext,
    *,
    workspace: str,
    title: str,
    starts_on: date,
    site: tuple[float, float],
    policy: RefundPolicy,
    mandate: Mandate,
    seed_divers: int,
) -> str:
    with ctx.database.transaction() as connection:
        booking_id = tx.create_booking(
            connection,
            workspace=workspace,
            title=title,
            starts_on=starts_on,
            site=site,
            policy=policy,
            mandate=mandate,
        )
    for name in SEED_NAMES[:seed_divers]:
        await service.authorize_diver(
            ctx.database, ctx.paypal, booking_id, name, ctx.seed_card, seeded=True
        )
    return booking_id


async def assess(ctx: DepositsContext, booking_id: str) -> dict[str, Any]:
    with ctx.database.transaction() as connection:
        row = connection.execute(
            "SELECT * FROM deposit_bookings WHERE id=%s", (booking_id,)
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
        if any(
            s["status"] in ("proposed", "approved")
            for s in tx.settlements(connection, booking_id)
        ):
            return {"settlementId": None, "reason": "SETTLEMENT_ALREADY_OPEN"}
        evidence = tx.evidence(connection, booking_id)
    policy, mandate = tx.policy_of(row), tx.mandate_of(row)
    rules = rule_facts(evidence, policy.tripDays)
    agent = await ctx.assessor(row, evidence) if ctx.assessor else None
    facts = agent or rules
    if facts is None:
        return {"settlementId": None, "reason": "NO_CANCELLATION_EVIDENCE"}
    source: Literal["ai", "no_ai"] = "ai" if agent else "no_ai"
    with ctx.database.transaction() as connection:
        plan = settle(policy, facts, tx.payments(connection, booking_id))
        check = check_mandate(
            mandate, facts, plan, datetime.now(UTC).date().isoformat()
        )
        if source == "no_ai":
            check.reasons.append("NO_AI_NEEDS_APPROVAL")
        elif not agrees(facts, rules):
            check.reasons.append("AI_AND_RULES_DISAGREE")
        check.withinMandate = not check.reasons
        settlement_id = tx.save_settlement(
            connection, booking_id, source=source, facts=facts, plan=plan, check=check
        )
    outcomes: dict[str, str] = {}
    if check.withinMandate:
        outcomes = await service.execute_settlement(
            ctx.database, ctx.paypal, booking_id, settlement_id, "agent"
        )
    return {"settlementId": settlement_id, "executed": outcomes}


async def finalize(ctx: DepositsContext, booking_id: str) -> dict[str, str]:
    """Trip start: capture every deposit still on hold in full."""
    with ctx.database.transaction() as connection:
        held = [
            row
            for row in tx.divers(connection, booking_id)
            if row["state"] == "authorized"
        ]
        command_ids = [
            str(
                tx.record_command(
                    connection,
                    booking_id=booking_id,
                    diver_id=str(row["id"]),
                    kind="capture",
                    amount_minor=row["authorized_minor"],
                    final_capture=True,
                )["id"]
            )
            for row in held
        ]
    return {
        command_id: await service.execute(ctx.database, ctx.paypal, command_id)
        for command_id in command_ids
    }


@activity.defn
async def assess_booking(booking_id: str) -> dict[str, Any]:
    return await assess(context(), booking_id)


@activity.defn
async def execute_approved(booking_id: str, settlement_id: str) -> dict[str, str]:
    ctx = context()
    return await service.execute_settlement(
        ctx.database, ctx.paypal, booking_id, settlement_id, "organizer"
    )


@activity.defn
async def finalize_booking(booking_id: str) -> dict[str, str]:
    return await finalize(context(), booking_id)


@activity.defn
async def reconcile_booking(booking_id: str) -> dict[str, str]:
    ctx = context()
    return await service.reconcile(ctx.database, ctx.paypal, booking_id)


DEPOSIT_ACTIVITIES = [
    assess_booking,
    execute_approved,
    finalize_booking,
    reconcile_booking,
]


@workflow.defn
class GroupBookingWorkflow:
    """Waits until trip start; checks evidence on demand and executes approvals."""

    def __init__(self) -> None:
        self.check_requested = False
        self.approved: list[str] = []

    @workflow.signal
    def check_now(self) -> None:
        self.check_requested = True

    @workflow.signal
    def approve(self, settlement_id: str) -> None:
        self.approved.append(settlement_id)

    @workflow.run
    async def run(self, booking_id: str, settle_at: str) -> str:
        # Activities are safe to retry: money commands reuse their stored request id.
        timeout = timedelta(minutes=5)
        retry = RetryPolicy(maximum_attempts=3)
        deadline = datetime.fromisoformat(settle_at)
        while True:
            remaining = (deadline - workflow.now()).total_seconds()
            if remaining > 0:
                try:
                    await workflow.wait_condition(
                        lambda: self.check_requested or bool(self.approved),
                        timeout=timedelta(seconds=remaining),
                    )
                except TimeoutError:
                    pass
            if self.approved:
                settlement_id = self.approved.pop(0)
                await workflow.execute_activity(
                    execute_approved,
                    args=[booking_id, settlement_id],
                    start_to_close_timeout=timeout,
                    retry_policy=retry,
                )
            elif self.check_requested:
                self.check_requested = False
                await workflow.execute_activity(
                    assess_booking,
                    booking_id,
                    start_to_close_timeout=timeout,
                    retry_policy=retry,
                )
            else:
                for step in (reconcile_booking, finalize_booking):
                    await workflow.execute_activity(
                        step,
                        booking_id,
                        start_to_close_timeout=timeout,
                        retry_policy=retry,
                    )
                return "finalized"
