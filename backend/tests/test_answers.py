from uuid import uuid4

import pytest
from test_budget import snapshot

from dive_trip.modules.planning.answer_contract import AnswerPlan, Receipt
from dive_trip.modules.planning.compiler import compile_answer
from dive_trip.modules.planning.evidence import Binding, Compilation, Evidence
from dive_trip.modules.trips.public import Snapshot, build_proposal


def context():
    binding = Binding(
        ownerId=str(uuid4()), tripId=str(uuid4()), runId=str(uuid4()), baseVersion=1
    )
    evidence = Evidence(
        binding=binding,
        kind="budget",
        origin="call-1",
        snapshot=Snapshot.model_validate(snapshot()),
    )
    return Compilation(binding, "answer-1", (evidence,)), evidence


def plan(kind, evidence):
    return {"version": "1", "answer": {"kind": kind, "evidenceRef": evidence.id}}


def test_compiler_owns_money_sources_and_null_presentation():
    ctx, evidence = context()
    result = compile_answer(plan("budget", evidence), ctx).wire()
    budget = result["body"]["budget"]
    assert budget["known"] == {"minor": 430000, "display": "TWD 4300.00"}
    assert budget["target"] == {"minor": 1000000, "display": "TWD 10000.00"}
    assert budget["containsDemo"] is True
    assert budget["sources"][0]["source"]["kind"] == "demo"
    assert budget["locked"]["known"]["minor"] == 0
    assert compile_answer(plan("budget", evidence), ctx).wire() == result


@pytest.mark.parametrize(
    "extra",
    [{"text": "免費"}, {"amount": 0}, {"html": "<b>done</b>"}, {"status": "applied"}],
)
def test_model_cannot_supply_public_answer_content(extra):
    ctx, evidence = context()
    raw = plan("budget", evidence)
    raw["answer"].update(extra)
    with pytest.raises(ValueError):
        compile_answer(raw, ctx)


def test_foreign_duplicate_and_superseded_evidence_rejected():
    ctx, evidence = context()
    foreign_ctx, foreign = context()
    with pytest.raises(ValueError):
        compile_answer(plan("budget", foreign), ctx)
    with pytest.raises(ValueError):
        compile_answer(
            plan("budget", evidence),
            Compilation(ctx.binding, "event", (evidence, foreign)),
        )
    with pytest.raises(ValueError):
        compile_answer(
            plan("budget", evidence),
            Compilation(ctx.binding, "event", (evidence, evidence)),
        )
    base = evidence.snapshot
    draft = build_proposal(base, [], [entry.item for entry in base.entries], "agent")
    old = Evidence(
        binding=ctx.binding, kind="validation", origin="old", snapshot=base, draft=draft
    )
    proposed = Evidence(
        binding=ctx.binding,
        kind="proposal",
        origin="proposal",
        snapshot=base,
        draft=draft,
        validation_ref=old.id,
    )
    latest = Evidence(
        binding=ctx.binding, kind="validation", origin="new-attempt", snapshot=base
    )
    updated = Compilation(ctx.binding, "event", (old, proposed, latest))
    with pytest.raises(ValueError):
        compile_answer(plan("proposal", proposed), updated)
    with pytest.raises(ValueError):
        compile_answer(plan("budget", old), updated)


def test_committed_receipt_is_terminal_and_bypasses_model():
    ctx, evidence = context()
    receipt = Evidence(
        binding=ctx.binding,
        kind="receipt",
        origin="decision",
        receipt=Receipt(status="applied", version=2),
    )
    terminal = Compilation(ctx.binding, "decision", (evidence, receipt))
    assert compile_answer(plan("receipt", receipt), terminal).wire()["body"] == {
        "kind": "receipt",
        "status": "applied",
        "version": 2,
    }
    with pytest.raises(ValueError):
        compile_answer(plan("budget", evidence), terminal)
    with pytest.raises(ValueError):
        compile_answer(
            {"version": "1", "answer": {"kind": "clarify", "fields": ["budget"]}},
            terminal,
        )


@pytest.mark.parametrize(
    "raw",
    [
        {"version": 1, "answer": {"kind": "clarify", "fields": ["budget"]}},
        {"version": "1", "answer": {"kind": "clarify", "fields": ["budget", "budget"]}},
        {"version": "1", "answer": {"kind": "clarify", "fields": []}},
    ],
)
def test_answer_plan_is_strict(raw):
    with pytest.raises(ValueError):
        AnswerPlan.model_validate(raw)
