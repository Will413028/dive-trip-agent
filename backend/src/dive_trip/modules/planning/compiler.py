"""Pure product compiler. No model text, money or HTML becomes a public answer."""

from typing import Any

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.trips.public import budget_model

from .answer_contract import AcceptedAnswer, AnswerPlan, Clarify, Unsupported, money
from .evidence import Compilation, Evidence, hash_tuple


def demo(item: CatalogItem) -> bool:
    return item.price.basis == "demo" or any(
        source.kind == "demo" for source in item.sources
    )


def source_view(item: CatalogItem) -> dict[str, Any]:
    source = next(source for source in item.sources if source.id == item.price.sourceId)
    return {
        "source": source.model_dump(mode="json"),
        "provenanceSources": [
            value.model_dump(mode="json")
            for value in item.sources
            if value.kind == "demo" and value.id != item.price.sourceId
        ],
    }


def budget_view(evidence: Evidence) -> dict[str, Any]:
    base = evidence.snapshot
    if base is None:
        raise ValueError("AGENT_ANSWER_EVIDENCE")
    if evidence.kind == "budget":
        snapshot, budget, issues, scope = base, budget_model(base), [], "current"
    elif evidence.kind in ("validation", "proposal") and evidence.draft is not None:
        snapshot, budget = evidence.draft.next, evidence.draft.budget
        issues, scope = evidence.draft.issues, "candidate"
    else:
        raise ValueError("AGENT_ANSWER_EVIDENCE")
    target = snapshot.requirements.budgetMinor
    locked: dict[str, Any] = {
        "status": "unavailable",
        "known": None,
        "entryIds": [entry.id for entry in base.entries if entry.locked],
        "unknownEntryIds": None,
    }
    if all(
        issue.code in ("BUDGET_EXCEEDED", "UNKNOWN_COST", "EXCLUDED_COST")
        for issue in issues
    ):
        try:
            subtotal = budget_model(
                snapshot.model_copy(
                    update={
                        "entries": [entry for entry in base.entries if entry.locked]
                    }
                )
            )
            locked.update(
                known=money(subtotal.knownMinor).model_dump(),
                unknownEntryIds=subtotal.unknownEntryIds,
                status="budget-unspecified"
                if target is None
                else "locked-known-cost-exceeds-budget"
                if subtotal.knownMinor > target
                else "not-proven-infeasible",
            )
        except ValueError:
            pass
    entries = {entry.id: entry for entry in snapshot.entries}
    return {
        "scope": scope,
        "baseVersion": evidence.binding.baseVersion,
        "known": money(budget.knownMinor).model_dump(),
        "target": money(target).model_dump() if target is not None else None,
        "withinBudget": budget.withinBudget,
        "containsDemo": any(demo(e.item) for e in snapshot.entries),
        "unknownCosts": [
            {
                "entryId": key,
                "title": entries[key].item.title,
                "reason": entries[key].item.price.unknownReason,
                **source_view(entries[key].item),
            }
            for key in budget.unknownEntryIds
        ],
        "exclusions": snapshot.exclusions,
        "issues": [
            {
                "code": issue.code,
                **({"entryId": issue.entryId} if issue.entryId else {}),
            }
            for issue in issues
        ],
        "sources": [
            {"entryId": entry.id, **source_view(entry.item)}
            for entry in snapshot.entries
        ],
        "locked": locked,
    }


def envelope(
    context: Compilation, body: dict[str, Any], refs: list[str]
) -> AcceptedAnswer:
    if not 1 <= len(context.event_id) <= 128:
        raise ValueError("invalid event ID")
    return AcceptedAnswer.model_validate(
        {
            "schemaVersion": 1,
            "templateVersion": 1,
            "runId": context.binding.runId,
            "answerId": "ans_"
            + hash_tuple([context.binding.runId, context.event_id, 1]),
            "body": body,
            "evidenceRefs": refs,
        }
    )


def compile_answer(raw: Any, context: Compilation) -> AcceptedAnswer:
    answer = AnswerPlan.model_validate(raw).answer
    available, committed = context.resolve()
    if committed is not None and (
        answer.kind != "receipt" or answer.evidenceRef != committed.id
    ):
        raise ValueError("AGENT_ANSWER_EVIDENCE")
    refs: list[str] = []

    def get(key: str) -> Evidence:
        if key not in available:
            raise ValueError("AGENT_ANSWER_EVIDENCE")
        refs.append(key)
        return available[key]

    body: dict[str, Any]
    if isinstance(answer, (Clarify, Unsupported)):
        body = answer.model_dump(mode="json")
    elif answer.kind == "compare-budget":
        current, candidate = get(answer.currentRef), get(answer.candidateRef)
        if current.kind != "budget" or candidate.kind != "validation":
            raise ValueError("AGENT_ANSWER_EVIDENCE")
        body = {
            "kind": answer.kind,
            "current": budget_view(current),
            "candidate": budget_view(candidate),
        }
    else:
        evidence = get(answer.evidenceRef)
        body = {"kind": answer.kind}
        match answer.kind:
            case "requirements":
                if evidence.kind != "requirements" or evidence.snapshot is None:
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                requirements = evidence.snapshot.requirements.model_dump(mode="json")
                target = requirements.pop("budgetMinor")
                requirements["target"] = (
                    money(target).model_dump() if target is not None else None
                )
                body.update(
                    version=evidence.binding.baseVersion, requirements=requirements
                )
            case "destinations":
                if evidence.kind != "destinations":
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                body["destinations"] = [
                    {
                        "id": destination,
                        "itemCount": sum(
                            item.destinationId == destination
                            for item in evidence.catalog
                        ),
                        "demoItemCount": sum(
                            item.destinationId == destination and demo(item)
                            for item in evidence.catalog
                        ),
                    }
                    for destination in ("xiaoliuqiu", "green-island", "kenting")
                ]
            case "items":
                if evidence.kind != "items" or (
                    not answer.itemIds and evidence.catalog
                ):
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                items = {item.id: item for item in evidence.catalog}
                if any(key not in items for key in answer.itemIds):
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                body.update(
                    destinationId=evidence.destination,
                    total=evidence.total,
                    omittedCount=evidence.total - len(answer.itemIds),
                    items=[
                        {
                            "id": item.id,
                            "title": item.title,
                            "audience": item.audience,
                            "capacityPerRoom": item.capacityPerRoom,
                            "price": money(item.price.unitMinor).model_dump()
                            if item.price.unitMinor is not None
                            else None,
                            "unit": item.price.unit,
                            "unknownReason": item.price.unknownReason,
                            "containsDemo": demo(item),
                            **source_view(item),
                        }
                        for item in (items[key] for key in answer.itemIds)
                    ],
                )
            case "budget" | "conflict" | "proposal":
                if answer.kind == "conflict" and (
                    evidence.kind != "validation"
                    or evidence.draft is None
                    or evidence.draft.canApply
                ):
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                if answer.kind == "proposal":
                    if (
                        evidence.kind != "proposal"
                        or evidence.draft is None
                        or not evidence.draft.canApply
                    ):
                        raise ValueError("AGENT_ANSWER_EVIDENCE")
                    body.update(
                        proposalRef=evidence.id, changeCount=len(evidence.draft.changes)
                    )
                body["budget"] = budget_view(evidence)
            case "receipt":
                if evidence.kind != "receipt" or evidence.receipt is None:
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                receipt = evidence.receipt
                if receipt.version < context.binding.baseVersion or (
                    receipt.status == "applied"
                    and receipt.version != context.binding.baseVersion + 1
                ):
                    raise ValueError("AGENT_ANSWER_EVIDENCE")
                body.update(receipt.model_dump(mode="json"))
    return envelope(context, body, refs)


def compile_failure(context: Compilation) -> AcceptedAnswer:
    _, committed = context.resolve()
    if committed is not None:
        if committed.receipt is None:
            raise ValueError("AGENT_ANSWER_EVIDENCE")
        return envelope(
            context,
            {
                "kind": "failure",
                "reason": "incomplete-run",
                "committed": committed.receipt.model_dump(mode="json"),
            },
            [committed.id],
        )
    return envelope(
        context, {"kind": "failure", "reason": "invalid-answer", "committed": None}, []
    )
