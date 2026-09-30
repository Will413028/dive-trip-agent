"""Transaction orchestration for the isolated fixture execution path."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from dive_trip.modules.catalog.public import CatalogItem, load_catalog
from dive_trip.modules.identity.public import require_owner
from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.answer_contract import AnswerPlan, EvidencePlan
from dive_trip.modules.planning.argument_diagnostic import ArgumentDiagnostic
from dive_trip.modules.planning.compiler import (
    compile_answer,
    compile_failure,
    demo,
    source_view,
)
from dive_trip.modules.planning.evidence import (
    Binding,
    Compilation,
    Evidence,
    Kind,
    hash_tuple,
)
from dive_trip.modules.planning.tool_contract import validate_candidate
from dive_trip.modules.trips import transactions as trips
from dive_trip.modules.trips.agent_changes import expand_agent_changes
from dive_trip.modules.trips.public import (
    ProposalDraft,
    Snapshot,
    budget_model,
    build_proposal,
)
from dive_trip.modules.usage.public import (
    ModelUsageEvent,
    lock_global,
    require_fixture_binding,
)
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError, ToolArgumentsRejected

from .confirmation import commit_confirmation
from .recovery import recover_expired
from .runtime_accounting import RuntimeAccounting


class PlanningService:
    def __init__(
        self,
        database: Database,
        catalog: Any,
        *,
        accounting: RuntimeAccounting | None = None,
    ) -> None:
        self.database = database
        self.catalog = load_catalog(catalog)
        self.accounting = accounting

    @staticmethod
    def validation_draft(
        base: Snapshot, args: dict[str, Any], catalog: list[CatalogItem]
    ) -> ProposalDraft:
        try:
            expanded = [
                change.model_dump(mode="json")
                for change in expand_agent_changes(base, args["changes"])
            ]
            return build_proposal(base, expanded, catalog, "agent")
        except ValueError:
            return build_proposal(base, None, catalog, "agent")

    def start(
        self, owner: str, trip_id: str, request_id: str, message: str, base_version: int
    ) -> tuple[dict[str, Any], bool]:
        if self.accounting is not None:
            raise DomainError("ADMISSION_REQUIRED")
        trips.valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, owner, lock=True)
            trip = trips.get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            recover_expired(connection, owner, trip_id)
            row, created = planning.start_run(
                connection,
                trip_id,
                trip.version,
                request_id,
                message,
                base_version,
                self.catalog,
            )
            require_fixture_binding(connection, str(row["id"]))
            return row, created

    def worker_binding(self, workflow_id: str) -> Binding:
        with self.database.transaction() as connection:
            trip_id, run_id = planning.workflow_identity(connection, workflow_id)
            owner = trips.worker_owner(connection, trip_id)
            require_owner(connection, owner, lock=True)
            trips.get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            row = planning.require_run(connection, trip_id, run_id)
            return Binding(
                ownerId=owner,
                tripId=trip_id,
                runId=run_id,
                baseVersion=row["base_version"],
            )

    def worker_execution(
        self, workflow_id: str, execution_id: str, *, bind: bool = False
    ) -> Binding:
        trips.valid_ids(execution_id)
        binding = self.worker_binding(workflow_id)
        with self.scope(binding, active=bind) as (connection, row, _):
            if row["execution_run_id"] is None and bind:
                planning.bind_execution(connection, binding.runId, execution_id)
            elif str(row["execution_run_id"]) != execution_id:
                raise DomainError("TEMPORAL_EXECUTION_CONFLICT")
        return binding

    @contextmanager
    def scope(
        self, binding: Binding, *, active: bool = True
    ) -> Iterator[tuple[Any, dict[str, Any], Snapshot]]:
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, binding.ownerId, lock=True)
            trips.get_trip(connection, binding.ownerId, binding.tripId, lock=True)
            require_owner(connection, binding.ownerId)
            row = planning.require_run(
                connection, binding.tripId, binding.runId, active=active
            )
            if self.accounting is None:
                require_fixture_binding(connection, binding.runId)
            else:
                self.accounting.authorize(connection, binding, active)
            if row["base_version"] != binding.baseVersion:
                raise DomainError("RUN_STATE_CONFLICT")
            base = trips.get_version(connection, binding.tripId, binding.baseVersion)
            yield connection, row, base

    def begin_model(self, binding: Binding, activity_id: str) -> datetime:
        with self.scope(binding) as (connection, row, _):
            deadline: datetime = min(
                row["lease_expires_at"], row["created_at"] + timedelta(seconds=55)
            )
            if deadline <= datetime.now(UTC):
                raise DomainError("AGENT_DEADLINE")
            if self.accounting is not None:
                self.accounting.start(connection, binding, activity_id)
            planning.start_model_step(
                connection, binding.tripId, binding.runId, activity_id
            )
            return deadline

    def account_usage(self, binding: Binding, event: ModelUsageEvent) -> None:
        if self.accounting is None:
            raise DomainError("PROVIDER_CONFLICT")
        with self.scope(binding) as (connection, _, _):
            self.accounting.complete(connection, binding, event)

    def recover(
        self,
        binding: Binding,
        *,
        interrupted: bool = False,
        rejected_activity: str | None = None,
    ) -> dict[str, Any]:
        with self.scope(binding, active=False) as (connection, before, _):
            known_rejection = (
                not interrupted
                and rejected_activity is not None
                and before["status"] == "running"
                and bool(before["lease_live"])
                and planning.has_argument_rejection(
                    connection, binding.runId, rejected_activity
                )
            )
            row = planning.end_failed(
                connection,
                binding.tripId,
                binding.runId,
                compile_failure(Compilation(binding, "failure-answer", ())),
                interrupted=interrupted,
            )
            if self.accounting is not None and row["status"] in (
                "failed",
                "interrupted",
            ):
                self.accounting.settle(
                    connection,
                    binding,
                    failed=True,
                    rejected_activity=rejected_activity if known_rejection else None,
                )
            return {
                "status": row["status"],
                "workflowId": row["workflow_id"],
                "receipt": row["committed_receipt"],
                "answers": planning.accepted_answers(connection, binding.runId),
            }

    def complete_model(self, binding: Binding, activity_id: str, calls: Any) -> None:
        rejected = False
        diagnostic: ArgumentDiagnostic | None = None
        with self.scope(binding) as (connection, row, _):
            previous = planning.tool_calls(connection, binding.runId)
            try:
                parsed = validate_candidate(
                    calls,
                    {call["call_id"] for call in previous},
                    row["tool_steps"],
                    proposed=row["proposal_id"] is not None,
                )
            except ToolArgumentsRejected as error:
                parsed, rejected = [], True
                if not isinstance(error.diagnostic, ArgumentDiagnostic):
                    raise DomainError(
                        "AGENT_MODEL_RESPONSE_DIAGNOSTIC_INVALID"
                    ) from None
                diagnostic = error.diagnostic
            # Reserve the whole validated batch in model order before the SDK sees it.
            for call in parsed:
                if call.name == "final_answer":
                    planning.consume_final_tool(
                        connection, binding.tripId, binding.runId, call.id
                    )
                else:
                    planning.start_tool(
                        connection,
                        binding.tripId,
                        binding.runId,
                        call.id,
                        call.name,
                        call.args,
                    )
            planning.complete_model_step(
                connection, binding.tripId, binding.runId, activity_id
            )
            if rejected:
                if diagnostic is None:
                    raise DomainError("AGENT_MODEL_RESPONSE_DIAGNOSTIC_INVALID")
                planning.mark_argument_rejection(
                    connection, binding.runId, activity_id, diagnostic
                )
        if rejected:
            raise ToolArgumentsRejected()

    def tool(self, binding: Binding, call_id: str) -> dict[str, Any]:
        with self.scope(binding) as (connection, row, base):
            calls = planning.tool_calls(connection, binding.runId)
            call = next((value for value in calls if value["call_id"] == call_id), None)
            if call is None or call["completed"] or call["name"] == "propose_changes":
                raise DomainError("AGENT_TOOL_CONFLICT")
            name, args = call["name"], call["args"]
            catalog = load_catalog(row["catalog_snapshot"])
            validation_id = None
            private: dict[str, Any] = {}
            result: dict[str, Any]
            kind: Kind
            if name == "validate_changes":
                draft = self.validation_draft(base, args, catalog)
                validation_id = str(uuid4()) if draft.canApply else None
                result = {
                    "canApply": draft.canApply,
                    "validationId": validation_id,
                    "budget": draft.budget.model_dump(),
                    "currency": "TWD",
                    "unit": "minor",
                    "issues": [
                        {"code": issue.code, "entryId": issue.entryId}
                        for issue in draft.issues
                    ],
                }
                private = {"draft": draft.model_dump(mode="json")}
                kind = "validation"
            elif name == "calculate_budget":
                result = {
                    **budget_model(base).model_dump(),
                    "currency": "TWD",
                    "unit": "minor",
                    "containsDemo": any(demo(entry.item) for entry in base.entries),
                    "exclusions": base.exclusions,
                }
                kind = "budget"
            elif name == "find_destinations":
                result = {
                    "destinations": [
                        {
                            "id": destination,
                            "itemCount": sum(
                                item.destinationId == destination for item in catalog
                            ),
                        }
                        for destination in ("xiaoliuqiu", "green-island", "kenting")
                    ]
                }
                kind = "destinations"
            elif name == "find_items":
                if row["evaluation_fault"] == "catalog-timeout":
                    result = {
                        "error": "CATALOG_TIMEOUT",
                        "items": [],
                        "retryable": False,
                    }
                    planning.complete_tool(
                        connection,
                        binding.tripId,
                        binding.runId,
                        call_id,
                        {"public": result},
                        None,
                    )
                    return result
                items = [
                    item
                    for item in catalog
                    if item.destinationId == args["destinationId"]
                ]
                result = {
                    "total": len(items),
                    "omittedCount": max(0, len(items) - 20),
                    "items": [
                        {
                            "id": item.id,
                            "title": item.title,
                            "audience": item.audience,
                            "capacityPerRoom": item.capacityPerRoom,
                            "price": item.price.model_dump(mode="json"),
                            "containsDemo": demo(item),
                            **source_view(item),
                        }
                        for item in items[:20]
                    ],
                }
                kind = "items"
            else:
                raise DomainError("AGENT_TOOL_NOT_ALLOWED")
            from dive_trip.modules.planning.evidence import evidence_identity

            result["evidenceRef"] = evidence_identity(binding, kind, call_id)
            planning.complete_tool(
                connection,
                binding.tripId,
                binding.runId,
                call_id,
                {"public": result, **private},
                validation_id,
            )
            return result

    def evidence(
        self,
        binding: Binding,
        base: Snapshot,
        row: dict[str, Any],
        calls: list[dict[str, Any]],
    ) -> tuple[Evidence, ...]:
        values = [
            Evidence(
                binding=binding,
                kind="requirements",
                origin="bound-snapshot",
                snapshot=base,
            )
        ]
        catalog = tuple(load_catalog(row["catalog_snapshot"]))
        for call in calls:
            name, origin = call["name"], call["call_id"]
            if name == "validate_changes":
                draft = (
                    self.validation_draft(base, call["args"], list(catalog))
                    if call["completed"]
                    else None
                )
                if draft is not None and (
                    draft.model_dump(mode="json") != call["result"].get("draft")
                    or draft.canApply != (call["validation_id"] is not None)
                ):
                    raise DomainError("AGENT_INVALID_VALIDATION")
                values.append(
                    Evidence(
                        binding=binding,
                        kind="validation",
                        origin=origin,
                        snapshot=base,
                        draft=draft,
                    )
                )
            elif call["completed"] and name == "calculate_budget":
                values.append(
                    Evidence(
                        binding=binding, kind="budget", origin=origin, snapshot=base
                    )
                )
            elif call["completed"] and name == "find_destinations":
                values.append(
                    Evidence(
                        binding=binding,
                        kind="destinations",
                        origin=origin,
                        catalog=catalog,
                    )
                )
            elif call["completed"] and name == "find_items":
                if call["result"]["public"].get("error") == "CATALOG_TIMEOUT":
                    continue
                destination = call["args"]["destinationId"]
                items = tuple(
                    item for item in catalog if item.destinationId == destination
                )
                values.append(
                    Evidence(
                        binding=binding,
                        kind="items",
                        origin=origin,
                        catalog=items[:20],
                        total=len(items),
                        destination=destination,
                    )
                )
        return tuple(values)

    def finish_answer(self, binding: Binding, plan: AnswerPlan) -> dict[str, object]:
        with self.scope(binding) as (connection, row, base):
            evidence = self.evidence(
                binding, base, row, planning.tool_calls(connection, binding.runId)
            )
            answer = compile_answer(
                plan, Compilation(binding, "start-answer", evidence)
            )
            planning.finish_run(connection, binding.tripId, binding.runId, answer)
            if self.accounting is not None:
                self.accounting.settle(connection, binding)
            return answer.wire()

    def prepare_proposal(self, binding: Binding, call_id: str) -> dict[str, Any]:
        with self.scope(binding) as (connection, row, base):
            calls = planning.tool_calls(connection, binding.runId)
            call = next((value for value in calls if value["call_id"] == call_id), None)
            if call is None or call["completed"] or call["name"] != "propose_changes":
                raise DomainError("AGENT_TOOL_CONFLICT")
            validation = planning.latest_validation(
                connection, binding.tripId, binding.runId, call["args"]["validationId"]
            )
            evidence = self.evidence(binding, base, row, calls)
            validated = next(
                value for value in evidence if value.origin == validation["call_id"]
            )
            draft = validated.draft
            if draft is None or not draft.canApply:
                raise DomainError("AGENT_INVALID_VALIDATION")
            trip = trips.get_trip(
                connection, binding.ownerId, binding.tripId, lock=True
            )
            trips.require_base(trip, binding.baseVersion)
            proposal_id, persisted = trips.save_proposal(
                connection,
                trip,
                [change.model_dump(mode="json") for change in draft.changes],
                load_catalog(row["catalog_snapshot"]),
            )
            if persisted != draft:
                raise DomainError("AGENT_INVALID_VALIDATION")
            proposed = Evidence(
                binding=binding,
                kind="proposal",
                origin=call_id,
                snapshot=base,
                draft=draft,
                validation_ref=validated.id,
            )
            planning.complete_tool(
                connection,
                binding.tripId,
                binding.runId,
                call_id,
                {"proposalId": proposal_id, "evidenceRef": proposed.id},
            )
            interrupt = planning.bind_proposal(
                connection, binding.tripId, binding.runId, proposal_id, call_id
            )
            answer = compile_answer(
                AnswerPlan(
                    version="1",
                    answer=EvidencePlan(kind="proposal", evidenceRef=proposed.id),
                ),
                Compilation(binding, "proposal-answer", (*evidence, proposed)),
            )
            planning.finish_run(
                connection, binding.tripId, binding.runId, answer, awaiting=True
            )
            if self.accounting is not None:
                self.accounting.settle(connection, binding)
            return {
                "interruptId": interrupt,
                "proposalId": proposal_id,
                "answer": answer.wire(),
            }

    def decide(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        *,
        event_request_id: str,
    ) -> dict[str, Any]:
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, binding.ownerId, lock=True)
            # Same lock order as manual mutations: receipt before trip row.
            request_id = f"temporal-resume:{binding.runId}"
            payload_hash = hash_tuple([binding.runId, interrupt_id, accepted])
            mutation = trips.claim_receipt(
                connection, binding.ownerId, request_id, "apply", payload_hash
            )
            trip = trips.get_trip(
                connection, binding.ownerId, binding.tripId, lock=True
            )
            require_owner(connection, binding.ownerId)
            require_fixture_binding(connection, binding.runId)
            return commit_confirmation(
                connection,
                binding,
                trip,
                interrupt_id,
                accepted,
                request_id,
                payload_hash,
                mutation,
                event_request_id,
            )
