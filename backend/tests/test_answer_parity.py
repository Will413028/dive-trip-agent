import json
import subprocess
from pathlib import Path
from uuid import uuid4

from test_budget import snapshot

from dive_trip.modules.planning.answer_contract import Receipt
from dive_trip.modules.planning.compiler import compile_answer
from dive_trip.modules.planning.evidence import Binding, Compilation, Evidence
from dive_trip.modules.trips.public import Snapshot, build_proposal


def test_all_answer_kinds_match_legacy_compiler_and_web_validator():
    binding = Binding(
        ownerId=str(uuid4()), tripId=str(uuid4()), runId=str(uuid4()), baseVersion=1
    )
    cases = []

    def add(answer, evidence):
        ctx = Compilation(binding, "parity", tuple(evidence))
        legacy = []
        for item in evidence:
            value = {
                "id": item.id,
                "kind": item.kind,
                "binding": binding.model_dump(),
                "originId": item.origin,
            }
            if item.kind in ("requirements", "budget"):
                value.update(scope="current", snapshot=item.snapshot.model_dump())
            if item.kind == "destinations":
                value.update(
                    scope="catalog", catalog=[i.model_dump() for i in item.catalog]
                )
            if item.kind == "items":
                value.update(
                    scope="catalog",
                    destinationId=item.destination,
                    items=[i.model_dump() for i in item.catalog],
                    total=item.total,
                )
            if item.kind in ("validation", "proposal"):
                draft = item.draft.model_dump()
                for issue in draft["issues"]:
                    if issue["entryId"] is None:
                        del issue["entryId"]
                value.update(
                    scope="candidate", base=item.snapshot.model_dump(), draft=draft
                )
                if item.kind == "validation":
                    value["validationId"] = (
                        str(uuid4()) if item.draft.canApply else None
                    )
                else:
                    value["validationRef"] = item.validation_ref
            if item.kind == "receipt":
                value.update(scope="committed", **item.receipt.model_dump())
            legacy.append(value)
        plan = {"version": "1", "answer": answer}
        cases.append(
            {
                "plan": plan,
                "context": {
                    "binding": binding.model_dump(),
                    "eventId": "parity",
                    "evidence": legacy,
                },
                "actual": compile_answer(plan, ctx).wire(),
            }
        )

    add({"kind": "clarify", "fields": ["destination", "budget"]}, [])
    add({"kind": "unsupported", "reason": "booking"}, [])
    for unknown in (False, True):
        raw = snapshot()
        raw["entries"][0]["locked"] = True
        if unknown:
            raw["entries"][1]["item"]["price"].update(
                unitMinor=None, unknownReason="待確認"
            )
            raw["exclusions"] = ["餐費未納入"]
        base = Snapshot.model_validate(raw)
        catalog = tuple(e.item for e in base.entries)
        for kind in ("requirements", "budget", "destinations", "items"):
            ev = Evidence(
                binding=binding,
                kind=kind,
                origin=kind,
                snapshot=base,
                catalog=catalog,
                destination="xiaoliuqiu",
                total=len(catalog),
            )
            answer = {"kind": kind, "evidenceRef": ev.id}
            if kind == "items":
                answer["itemIds"] = ["tour", "stay"]
            add(answer, [ev])
        for people in (2, 3):
            draft = build_proposal(
                base,
                [
                    {
                        "kind": "requirements",
                        "value": {**base.requirements.model_dump(), "people": people},
                    }
                ],
                list(catalog),
                "agent",
            )
            validation = Evidence(
                binding=binding,
                kind="validation",
                origin="validate",
                snapshot=base,
                draft=draft,
            )
            current = Evidence(
                binding=binding, kind="budget", origin="current", snapshot=base
            )
            add(
                {
                    "kind": "compare-budget",
                    "currentRef": current.id,
                    "candidateRef": validation.id,
                },
                [current, validation],
            )
            if draft.canApply:
                proposal = Evidence(
                    binding=binding,
                    kind="proposal",
                    origin="propose",
                    snapshot=base,
                    draft=draft,
                    validation_ref=validation.id,
                )
                add(
                    {"kind": "proposal", "evidenceRef": proposal.id},
                    [validation, proposal],
                )
            else:
                add({"kind": "conflict", "evidenceRef": validation.id}, [validation])
    for status, version in (("applied", 2), ("rejected", 3)):
        receipt = Evidence(
            binding=binding,
            kind="receipt",
            origin="decision",
            receipt=Receipt(status=status, version=version),
        )
        add({"kind": "receipt", "evidenceRef": receipt.id}, [receipt])

    result = subprocess.run(
        ["node", str(Path(__file__).with_name("legacy_answers.mjs"))],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    for case, expected in zip(cases, json.loads(result.stdout), strict=True):
        assert case["actual"] == expected, case["plan"]
