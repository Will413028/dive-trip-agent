"""Private Temporal-era accounting evidence; no public route or settlement IO."""

import re
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, Field, model_validator

from dive_trip.modules.planning.evidence import Binding
from dive_trip.modules.usage.provider import (
    ModelUsageEvent,
    ProviderBinding,
    reference_cost,
    validate_usage,
)
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import NonnegativeInt, WireModel

from .decision_evidence import CommittedDecision, read_decision_evidence
from .native_tool_evidence import CatalogTimeout


class InvocationEvidence(WireModel):
    id: str
    reservation_id: str
    kind: Literal["start", "resume"]
    status: Literal["active", "expired", "settled"]
    reservation_status: Literal["reserved", "expired", "settled"]
    max_cost_micros: NonnegativeInt
    charged_cost_micros: NonnegativeInt
    actual_cost_micros: NonnegativeInt | None
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def valid(self) -> Self:
        UUID(self.id)
        UUID(self.reservation_id)
        if (self.kind == "resume") != (self.max_cost_micros == 0):
            raise ValueError("INVALID_INVOCATION_COST")
        if self.charged_cost_micros != (
            self.max_cost_micros
            if self.actual_cost_micros is None
            else self.actual_cost_micros
        ):
            raise ValueError("INVALID_CHARGE")
        if (self.status == "settled") != (self.reservation_status == "settled"):
            raise ValueError("INVALID_SETTLEMENT")
        if self.expires_at <= self.created_at:
            raise ValueError("INVALID_INVOCATION_TIME")
        return self


class CallEvidence(WireModel):
    invocation_id: str
    status: Literal["started", "completed"]
    event: ModelUsageEvent
    started_at: AwareDatetime
    completed_at: AwareDatetime | None

    @model_validator(mode="after")
    def valid(self) -> Self:
        UUID(self.invocation_id)
        if (self.status == "completed") != (self.completed_at is not None):
            raise ValueError("INVALID_CALL_COMPLETION")
        if self.status == "started" and (
            self.event.usage is not None or self.event.providerEvidence is not None
        ):
            raise ValueError("INVALID_STARTED_CALL")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("INVALID_CALL_TIME")
        return self


class StepEvidence(WireModel):
    activity_id: Annotated[str, Field(min_length=1, max_length=128)]
    ordinal: Annotated[int, Field(ge=1, le=7)]
    completed: bool
    arguments_rejected: bool


class ToolEvidence(WireModel):
    call_id: Annotated[str, Field(min_length=1, max_length=128)]
    name: Literal[
        "find_destinations",
        "find_items",
        "calculate_budget",
        "validate_changes",
        "propose_changes",
    ]
    ordinal: Annotated[int, Field(ge=1, le=6)]
    completed: bool
    fault: Literal["catalog-timeout"] | None

    @model_validator(mode="after")
    def valid_fault(self) -> Self:
        if self.fault is not None and (not self.completed or self.name != "find_items"):
            raise ValueError("INVALID_TOOL_FAULT")
        return self


class UsageEvidence(WireModel):
    schemaVersion: Literal[3] = 3
    executor: Literal["temporal-v1"] = "temporal-v1"
    execution_run_id: str | None
    evaluation_fault: Literal["catalog-timeout"] | None
    status: Literal[
        "running", "awaiting_confirmation", "succeeded", "failed", "interrupted"
    ]
    run: Binding
    provider: ProviderBinding
    decision: CommittedDecision | None
    invocations: Annotated[list[InvocationEvidence], Field(min_length=1, max_length=2)]
    calls: Annotated[list[CallEvidence], Field(max_length=7)]
    steps: Annotated[list[StepEvidence], Field(max_length=7)]
    tools: Annotated[list[ToolEvidence], Field(max_length=6)]
    final_call_id: Annotated[str, Field(min_length=1, max_length=128)] | None

    @model_validator(mode="after")
    def bound(self) -> Self:
        if self.execution_run_id is not None:
            UUID(self.execution_run_id)
        invocations = {row.id: row for row in self.invocations}
        kinds = {row.kind for row in self.invocations}
        if ("resume" in kinds) != (self.decision is not None) or (
            self.decision is not None
            and (
                self.status != "succeeded"
                or self.decision.answer.runId != self.run.runId
            )
        ):
            raise ValueError("INVALID_DECISION_INVOCATION")
        calls = {row.event.callId: row for row in self.calls}
        if (
            len(invocations) != len(self.invocations)
            or len(kinds) != len(self.invocations)
            or "start" not in kinds
            or len({row.reservation_id for row in self.invocations})
            != len(self.invocations)
            or len(calls) != len(self.calls)
            or set(calls) != {row.activity_id for row in self.steps}
            or len(self.steps) != len(calls)
            or [row.ordinal for row in self.steps]
            != list(range(1, len(self.steps) + 1))
        ):
            raise ValueError("INVALID_EVIDENCE_BINDING")
        for call in self.calls:
            invocation = invocations.get(call.invocation_id)
            if invocation is None or invocation.kind != "start":
                raise ValueError("INVALID_CALL_BINDING")
            validate_usage(self.provider, call.event)
        for step in self.steps:
            if step.arguments_rejected and not step.completed:
                raise ValueError("INVALID_REJECTION")
            if step.completed and calls[step.activity_id].status != "completed":
                raise ValueError("MISSING_PRIVATE_USAGE")
        tool_ids = [tool.call_id for tool in self.tools]
        if (
            any(tool.fault is not None for tool in self.tools)
            and self.evaluation_fault != "catalog-timeout"
        ):
            raise ValueError("UNBOUND_EVALUATION_FAULT")
        if self.status in ("awaiting_confirmation", "succeeded") and any(
            not tool.completed for tool in self.tools
        ):
            raise ValueError("INCOMPLETE_TOOL_INVENTORY")
        if (
            len(set(tool_ids)) != len(tool_ids)
            or self.final_call_id in tool_ids
            or len(tool_ids) + (self.final_call_id is not None) > 6
            or [tool.ordinal for tool in self.tools]
            != list(range(1, len(tool_ids) + 1))
        ):
            raise ValueError("INVALID_TOOL_INVENTORY")
        costs = [reference_cost(self.provider, row.event) for row in self.calls]
        for invocation in self.invocations:
            if invocation.actual_cost_micros is not None:
                expected = (
                    0
                    if invocation.kind == "resume"
                    else (
                        sum(value for value in costs if value is not None)
                        if costs and all(value is not None for value in costs)
                        else None
                    )
                )
                if invocation.actual_cost_micros != expected:
                    raise ValueError("INVALID_ACTUAL_COST")
        return self


def read_usage_evidence(
    database: Database, binding: Binding, provider: ProviderBinding
) -> UsageEvidence:
    # Raw historical ADK reports retain their v1/v2 format and their own auditor.
    if re.fullmatch(r"python_test_[a-f0-9]{32}", database.schema) is None:
        raise DomainError("EVIDENCE_TEST_SCHEMA_REQUIRED")
    with database.transaction() as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        run = connection.execute(
            "SELECT r.base_version,r.executor,r.answer_contract_version,r.status,"
            "e.model_steps,e.execution_run_id,e.tool_steps,e.final_call_id,"
            "e.evaluation_fault "
            "FROM agent_runs r JOIN trips t ON t.id=r.trip_id "
            "JOIN planning_executions e ON e.run_id=r.id "
            "WHERE r.id=%s AND t.id=%s AND t.owner_id=%s",
            (binding.runId, binding.tripId, binding.ownerId),
        ).fetchone()
        if (
            run is None
            or run["base_version"] != binding.baseVersion
            or run["executor"] != "temporal-v1"
            or run["answer_contract_version"] != 1
        ):
            raise DomainError("EVIDENCE_OWNER_BINDING")
        invocations = connection.execute(
            "SELECT i.id,i.run_id,i.reservation_id,i.kind,"
            "i.provider,i.model,i.account_id,"
            "i.status,i.max_cost_micros,i.created_at,i.expires_at,"
            "q.id AS ledger_id,q.owner_id,q.logical_run_id,"
            "q.status AS reservation_status,q.max_cost_micros AS ledger_max,"
            "q.charged_cost_micros,q.actual_cost_micros "
            "FROM agent_invocations i LEFT JOIN quota_reservations q "
            "ON q.id=i.reservation_id "
            "WHERE i.run_id=%s ORDER BY i.created_at,i.id LIMIT 3",
            (binding.runId,),
        ).fetchall()
        reservations = connection.execute(
            "SELECT q.id FROM quota_reservations q WHERE q.logical_run_id=%s "
            "OR EXISTS(SELECT 1 FROM agent_invocations i "
            "WHERE i.reservation_id=q.id AND i.run_id=%s) ORDER BY q.id LIMIT 3",
            (binding.runId, binding.runId),
        ).fetchall()
        if {row["id"] for row in reservations} != {
            row["reservation_id"] for row in invocations
        }:
            raise DomainError("EVIDENCE_RESERVATION_INVENTORY")
        calls = connection.execute(
            "SELECT c.invocation_id,c.run_id,c.call_id,c.status,c.usage,"
            "c.provider_evidence,c.started_at,c.completed_at FROM model_calls c "
            "WHERE c.run_id=%s OR EXISTS (SELECT 1 FROM agent_invocations i "
            "WHERE i.id=c.invocation_id AND i.run_id=%s) "
            "ORDER BY c.started_at,c.call_id LIMIT 8",
            (binding.runId, binding.runId),
        ).fetchall()
        steps = connection.execute(
            "SELECT activity_id,ordinal,completed,arguments_rejected "
            "FROM planning_model_steps WHERE run_id=%s ORDER BY ordinal LIMIT 8",
            (binding.runId,),
        ).fetchall()
        tools = connection.execute(
            "SELECT call_id,name,ordinal,completed,result->'public' AS public_result "
            "FROM planning_tool_calls "
            "WHERE run_id=%s ORDER BY ordinal LIMIT 7",
            (binding.runId,),
        ).fetchall()
        for tool in tools:
            result = tool.pop("public_result")
            tool["fault"] = None
            if isinstance(result, dict) and "error" in result:
                try:
                    CatalogTimeout.model_validate(result)
                except ValueError:
                    raise DomainError("EVIDENCE_TOOL_FAULT") from None
                tool["fault"] = "catalog-timeout"
        if run["tool_steps"] != len(tools) + (run["final_call_id"] is not None):
            raise DomainError("EVIDENCE_TOOL_STEPS")
        if any(
            str(row["run_id"]) != binding.runId
            or str(row["owner_id"]) != binding.ownerId
            or str(row["logical_run_id"]) != binding.runId
            or row["ledger_id"] != row["reservation_id"]
            or row["ledger_max"] != row["max_cost_micros"]
            or (row["provider"], row["model"], row["account_id"])
            != (provider.provider, provider.model, provider.accountId)
            for row in invocations
        ) or any(str(row["run_id"]) != binding.runId for row in calls):
            raise DomainError("EVIDENCE_PROVIDER_BINDING")
        assert run is not None
        if run["model_steps"] != len(steps):
            raise DomainError("EVIDENCE_MODEL_STEPS")
        # Explicit projection: no request, prompt, credential, token or IP hash.
        projected: list[dict[str, Any]] = []
        for row in invocations:
            projected.append(
                {
                    key: str(row[key]) if key in ("id", "reservation_id") else row[key]
                    for key in InvocationEvidence.model_fields
                }
            )
        try:
            return UsageEvidence(
                status=run["status"],
                evaluation_fault=run["evaluation_fault"],
                execution_run_id=(
                    str(run["execution_run_id"])
                    if run["execution_run_id"] is not None
                    else None
                ),
                run=binding,
                provider=provider,
                decision=read_decision_evidence(connection, binding),
                invocations=[
                    InvocationEvidence.model_validate(row) for row in projected
                ],
                calls=[
                    CallEvidence(
                        invocation_id=str(row["invocation_id"]),
                        status=row["status"],
                        started_at=row["started_at"],
                        completed_at=row["completed_at"],
                        event=ModelUsageEvent(
                            kind="model-call-usage",
                            callId=row["call_id"],
                            usage=row["usage"],
                            providerEvidence=row["provider_evidence"],
                        ),
                    )
                    for row in calls
                ],
                steps=[StepEvidence.model_validate(row) for row in steps],
                tools=[ToolEvidence.model_validate(row) for row in tools],
                final_call_id=run["final_call_id"],
            )
        except ValueError:
            raise DomainError("EVIDENCE_INVALID") from None
