"""Differential migration vectors exercise the actual old and new domain code."""

import json
import subprocess
from copy import deepcopy
from pathlib import Path

from test_budget import snapshot

from dive_trip.modules.trips.domain import Snapshot
from dive_trip.modules.trips.proposal import build_proposal


def test_proposal_matches_legacy_rules():
    cases = []

    def add(base, changes, actor="agent"):
        cases.append(
            {
                "base": deepcopy(base),
                "changes": deepcopy(changes),
                "catalog": [deepcopy(e["item"]) for e in base["entries"]],
                "actor": actor,
            }
        )

    for people in range(1, 7):
        for divers in range(people + 1):
            for price in [None, 0, 50000, 9007199254740991]:
                base = snapshot()
                base["entries"][1]["item"]["price"].update(
                    unitMinor=price, unknownReason="未知" if price is None else None
                )
                add(
                    base,
                    [
                        {
                            "kind": "requirements",
                            "value": {
                                **base["requirements"],
                                "people": people,
                                "divers": divers,
                            },
                        }
                    ],
                )
    for locked in [False, True]:
        base = snapshot()
        base["entries"][0]["locked"] = locked
        for days in range(2, 8):
            add(
                base,
                [
                    {
                        "kind": "requirements",
                        "value": {**base["requirements"], "days": days},
                    }
                ],
            )
        for change in [
            {"kind": "lock", "entryId": "stay", "locked": False},
            {"kind": "remove", "entryId": "stay"},
            {"kind": "rooms", "entryId": "stay", "rooms": 2},
            {"kind": "rooms", "entryId": "stay", "rooms": True},
            {"kind": "move", "entryId": "stay", "day": 4, "slot": "morning"},
            {"kind": "replace", "entryId": "stay", "catalogId": "tour"},
        ]:
            add(base, [change])
            add(base, [change], "user")
    base = snapshot()
    for audience in ["all", "divers", "non-divers"]:
        base["entries"][1]["item"]["audience"] = audience
        add(base, [{"kind": "move", "entryId": "tour", "day": 2, "slot": "afternoon"}])
    add(base, [{"kind": "remove", "entryId": "tour"}, {"kind": "unknown"}])
    add(base, [{"kind": "remove", "entryId": "absent"}])
    add(
        base,
        [
            {
                "kind": "add",
                "entry": {
                    key: value
                    for key, value in base["entries"][0].items()
                    if key not in ("item", "locked")
                },
            }
        ],
    )
    add(base, [], "intruder")
    completed = subprocess.run(
        ["node", str(Path(__file__).with_name("legacy_domain.mjs"))],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    expected = json.loads(completed.stdout)
    for index, (case, legacy) in enumerate(zip(cases, expected, strict=True)):
        actual = build_proposal(
            Snapshot.model_validate(case["base"]),
            case["changes"],
            case["catalog"],
            case["actor"],
        ).model_dump(mode="json")
        # Omit optional entryId; nullable domain fields must stay null.
        for issue in actual["issues"]:
            if issue["entryId"] is None:
                del issue["entryId"]
        assert actual == legacy, f"parity vector {index}: {case['changes']}"
