"""Group deposits use cases and the per-booking Temporal workflow.

The workflow only waits and decides when to act; activities do the database and PayPal
work. An assessment proposes a settlement from the evidence: the agent's facts when an
assessor is configured and the daily live-call cap allows it (or a recorded result for
identical evidence once it does not), otherwise the deterministic rules ("No AI"). Only
a confident agent proposal that it asked to execute, that agrees with the rules, and
that fits the organizer's mandate executes without approval.
"""

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from dive_trip.modules.deposits import service
    from dive_trip.modules.deposits import transactions as tx
    from dive_trip.modules.deposits.assessor import (
        AgentAssessment,
        AgentInput,
        evidence_digest,
        input_digest,
    )
    from dive_trip.modules.deposits.domain import (
        Mandate,
        RefundPolicy,
        check_mandate,
        settle,
    )
    from dive_trip.modules.deposits.paypal import PayPalClient, SandboxCard
    from dive_trip.modules.deposits.rules import agrees, rule_facts
    from dive_trip.platform.database import Database
    from dive_trip.platform.errors import DomainError

# One agent run over a snapshot; raises when no model produced a valid assessment.
Assessor = Callable[[AgentInput], Awaitable[AgentAssessment]]

SEED_NAMES = ("Aiko (Osaka)", "Mateo (Madrid)", "Priya (Singapore)", "Lena (Berlin)")


@dataclass
class DepositsContext:
    database: Database
    paypal: PayPalClient
    seed_card: SandboxCard
    assessor: Assessor | None = None
    daily_live_cap: int = 50
    # Public sandbox client ID for the browser's PayPal checkout; None disables it.
    paypal_client_id: str | None = None


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


def _recorded(
    assessment: AgentAssessment, evidence: list[dict[str, Any]]
) -> dict[str, Any]:
    """Store citations by evidence content so identical evidence can replay them."""
    digests = {str(row["id"]): evidence_digest(row) for row in evidence}
    result = assessment.model_dump(mode="json")
    result["evidenceDigests"] = {
        evidence_id: digests[evidence_id]
        for evidence_id in (assessment.facts.evidenceIds if assessment.facts else [])
    }
    return result


def _replayed(
    result: dict[str, Any], evidence: list[dict[str, Any]]
) -> AgentAssessment:
    """Point a recorded result's citations at this booking's identical evidence."""
    by_digest: dict[str, str] = {}
    for row in evidence:
        by_digest.setdefault(evidence_digest(row), str(row["id"]))
    mapping = {
        old: by_digest[digest] for old, digest in result["evidenceDigests"].items()
    }
    recorded = {key: value for key, value in result.items() if key != "evidenceDigests"}
    if recorded["facts"]:
        recorded["facts"]["evidenceIds"] = [
            mapping[old] for old in recorded["facts"]["evidenceIds"]
        ]
    for citation in recorded["citations"]:
        citation["evidenceId"] = mapping[citation["evidenceId"]]
    return AgentAssessment.model_validate(recorded)


def failure_code(error: BaseException) -> str:
    """A short, secret-free reason for the call log (letters and underscores)."""
    status = getattr(error, "status_code", None)
    if isinstance(status, int):
        if status == 429:
            return "RATE_LIMITED"
        if status in (401, 403):
            return "PROVIDER_AUTH"
        if status == 404:
            return "MODEL_NOT_FOUND"
        if status >= 500:
            return "PROVIDER_UNAVAILABLE"
        return "PROVIDER_REJECTED"
    return re.sub(r"[^A-Za-z_]", "", type(error).__name__)[:80] or "ERROR"


async def consult_agent(
    ctx: DepositsContext,
    assessor: Assessor,
    booking_id: str,
    snapshot: AgentInput,
) -> tuple[AgentAssessment | None, str, str | None]:
    """Run the agent under the daily cap; returns (assessment, call id, why not)."""
    digest = input_digest(snapshot.policy, snapshot.evidence)
    with ctx.database.transaction() as connection:
        call = tx.reserve_agent_call(
            connection,
            booking_id,
            digest=digest,
            daily_cap=ctx.daily_live_cap,
            today=date.fromisoformat(snapshot.today),
        )
    call_id = str(call["id"])
    if call["mode"] == "capped":
        return None, call_id, "AI_DAILY_CAP_REACHED"
    if call["mode"] == "recorded":
        return _replayed(call["result"], snapshot.evidence), call_id, None
    try:
        assessment = await assessor(snapshot)
    except Exception as error:  # any model, tool, or limit failure
        with ctx.database.transaction() as connection:
            tx.finish_agent_call(
                connection,
                call_id,
                model=None,
                result=None,
                error_code=failure_code(error),
            )
            # Identical evidence already read by a live run beats "No AI".
            replay = tx.replay_agent_call(
                connection,
                booking_id,
                digest=digest,
                today=date.fromisoformat(snapshot.today),
            )
        if replay is not None:
            return (
                _replayed(replay["result"], snapshot.evidence),
                str(replay["id"]),
                None,
            )
        return None, call_id, "AI_UNAVAILABLE"
    with ctx.database.transaction() as connection:
        tx.finish_agent_call(
            connection,
            call_id,
            model=assessment.model,
            result=_recorded(assessment, snapshot.evidence),
            error_code=None,
        )
    return assessment, call_id, None


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
        payments = tx.payments(connection, booking_id)
    policy, mandate = tx.policy_of(row), tx.mandate_of(row)
    today = datetime.now(UTC).date().isoformat()
    rules = rule_facts(evidence, policy.tripDays)
    agent: AgentAssessment | None = None
    call_id: str | None = None
    unavailable: str | None = None
    if ctx.assessor is not None and evidence:
        snapshot = AgentInput(
            title=row["title"],
            starts_on=row["starts_on"],
            policy=policy,
            mandate=mandate,
            payments=payments,
            evidence=evidence,
            today=today,
        )
        agent, call_id, unavailable = await consult_agent(
            ctx, ctx.assessor, booking_id, snapshot
        )
    facts = agent.facts if agent and agent.facts else rules
    if facts is None:
        # Visible on the timeline, so a check that changes nothing is not silent.
        with ctx.database.transaction() as connection:
            tx.append(
                connection,
                booking_id,
                "no_cancellation_found",
                {"agent": "ran" if agent else unavailable or "not_configured"},
            )
        return {"settlementId": None, "reason": "NO_CANCELLATION_EVIDENCE"}
    source: Literal["ai", "no_ai"] = "ai" if agent and agent.facts else "no_ai"
    with ctx.database.transaction() as connection:
        plan = settle(policy, facts, tx.payments(connection, booking_id))
        check = check_mandate(mandate, facts, plan, today)
        if agent is None or agent.facts is None:
            check.reasons.append("NO_AI_NEEDS_APPROVAL")
            if ctx.assessor is not None:
                check.reasons.append(unavailable or "AI_FOUND_NO_CANCELLATION")
        else:
            if not agrees(agent.facts, rules):
                check.reasons.append("AI_AND_RULES_DISAGREE")
            if agent.confidence != "high":
                check.reasons.append("AI_NOT_CONFIDENT")
            if not agent.executionRequested:
                check.reasons.append("AI_REQUESTED_REVIEW")
        check.withinMandate = not check.reasons
        settlement_id = tx.save_settlement(
            connection,
            booking_id,
            source=source,
            facts=facts,
            plan=plan,
            check=check,
            agent_call_id=call_id,
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


DEPOSIT_ACTIVITIES: list[Callable[..., Any]] = [
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
