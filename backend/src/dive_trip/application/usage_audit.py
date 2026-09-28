"""Collector projection from independently read product and native evidence.

The owner of the worker must join its shutdown before capture. Neither this
pure reconciliation nor a closed Temporal history establishes physical drain.
"""

from typing import Literal

from dive_trip.modules.planning.answer_contract import Receipt
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import NonnegativeInt, WireModel

from .temporal_evidence import TemporalEvidence
from .usage_evidence import UsageEvidence


class ProductDecisionReceipt(Receipt):
    runId: str


class UsageAudit(WireModel):
    model: str
    runId: str
    complete: bool
    modelCalls: NonnegativeInt
    costMicros: NonnegativeInt | None
    nativeToolCalls: NonnegativeInt
    decisionReceipt: ProductDecisionReceipt | None
    faultObserved: Literal["catalog-timeout"] | None = None


def reconcile_usage(
    evidence: UsageEvidence,
    native: TemporalEvidence,
    *,
    previous: tuple[UsageEvidence, TemporalEvidence] | None = None,
) -> UsageAudit:
    if (
        evidence.execution_run_id != native.execution_run_id
        or native.workflow_id != f"dive-trip-v1:{evidence.run.runId}"
    ):
        raise DomainError("EVIDENCE_NATIVE_BINDING")
    resumed = evidence.decision is not None
    if resumed:
        if previous is None:
            raise DomainError("EVIDENCE_START_CHECKPOINT_REQUIRED")
        before, before_native = previous
        if (
            before.status != "awaiting_confirmation"
            or before.decision is not None
            or before_native.terminal != "awaiting_confirmation"
            or native.terminal != "completed"
            or before.run != evidence.run
            or before.provider != evidence.provider
            or before.evaluation_fault != evidence.evaluation_fault
            or before.execution_run_id != evidence.execution_run_id
            or before_native.namespace != native.namespace
            or before_native.workflow_id != native.workflow_id
            or before_native.execution_run_id != native.execution_run_id
            or before.calls != evidence.calls
            or before.steps != evidence.steps
            or before.tools != evidence.tools
            or before.final_call_id != evidence.final_call_id
            or before_native.models != native.models
            or before_native.catalog_fault_calls != native.catalog_fault_calls
            or len(before.invocations) != 1
            or before.invocations[0] != evidence.invocations[0]
            or before_native.event_count >= native.event_count
        ):
            raise DomainError("EVIDENCE_RESUME_GENERATION")
    elif previous is not None:
        raise DomainError("EVIDENCE_UNEXPECTED_CHECKPOINT")
    complete = (
        bool(evidence.calls)
        and all(call.status == "completed" for call in evidence.calls)
        and all(
            invocation.status == "settled"
            and invocation.reservation_status == "settled"
            and invocation.actual_cost_micros is not None
            for invocation in evidence.invocations
        )
    )
    return UsageAudit(
        model=evidence.provider.model,
        runId=evidence.run.runId,
        complete=complete,
        modelCalls=len(evidence.calls),
        costMicros=(
            sum(invocation.charged_cost_micros for invocation in evidence.invocations)
            if complete
            else None
        ),
        nativeToolCalls=sum(len(model.tool_calls or []) for model in native.models),
        faultObserved="catalog-timeout" if native.catalog_fault_calls else None,
        decisionReceipt=(
            ProductDecisionReceipt(
                runId=evidence.run.runId,
                **evidence.decision.receipt.model_dump(),
            )
            if evidence.decision is not None
            else None
        ),
    )
