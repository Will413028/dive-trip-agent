from copy import deepcopy

import pytest
from test_budget import snapshot

from dive_trip.modules.trips.domain import Snapshot
from dive_trip.modules.trips.proposal import build_proposal


def draft(value, changes, actor="agent"):
    return build_proposal(
        Snapshot.model_validate(value),
        changes,
        [entry["item"] for entry in value["entries"]],
        actor,
    )


def codes(result):
    return {issue.code for issue in result.issues}


def test_valid_move_preserves_bound_inputs():
    value = snapshot()
    original = deepcopy(value)
    result = draft(
        value, [{"kind": "move", "entryId": "tour", "day": 3, "slot": "morning"}]
    )
    assert result.canApply
    assert result.next.entries[1].day == 3
    assert result.budget.knownMinor == 430000
    assert value == original


@pytest.mark.parametrize(
    "change",
    [
        {
            "kind": "move",
            "entryId": "tour",
            "day": 3,
            "slot": "morning",
            "actor": "user",
        },
        {"kind": "rooms", "entryId": "stay", "rooms": True},
        {"kind": "rooms", "entryId": "stay", "rooms": "2"},
        {"kind": "remove", "entryId": " "},
    ],
)
def test_malformed_batch_does_not_partially_apply(change):
    value = snapshot()
    result = draft(value, [{"kind": "remove", "entryId": "tour"}, change])
    assert not result.canApply
    assert "INVALID_CHANGE" in codes(result)
    assert result.next.model_dump() == value
    assert result.changes == []


def test_unlock_is_a_separate_user_command():
    value = snapshot()
    value["entries"][1]["locked"] = True
    unlock = {"kind": "lock", "entryId": "tour", "locked": False}
    assert not draft(value, [unlock]).canApply
    assert draft(value, [unlock], "user").canApply
    result = draft(value, [unlock, {"kind": "remove", "entryId": "tour"}], "user")
    assert not result.canApply
    assert result.next.model_dump() == value


def test_locked_price_source_and_calendar_cannot_change():
    value = snapshot()
    value["entries"][1]["locked"] = True
    catalog = [deepcopy(entry["item"]) for entry in value["entries"]]
    catalog[1]["price"]["unitMinor"] = 1
    result = build_proposal(
        Snapshot.model_validate(value),
        [{"kind": "replace", "entryId": "tour", "catalogId": "tour"}],
        catalog,
        "agent",
    )
    assert not result.canApply
    assert "LOCKED_ENTRY" in codes(result)
    req = {**value["requirements"], "startDate": "2026-10-01"}
    assert "LOCKED_ENTRY" in codes(
        draft(value, [{"kind": "requirements", "value": req}])
    )


def test_capacity_does_not_invent_rooms_or_lose_known_costs():
    value = snapshot()
    req = {**value["requirements"], "people": 3}
    result = draft(value, [{"kind": "requirements", "value": req}])
    assert not result.canApply
    assert codes(result) == {"CAPACITY"}
    assert result.next.entries[0].rooms == 1
    assert result.budget.model_dump() == {
        "knownMinor": 480000,
        "unknownEntryIds": [],
        "withinBudget": None,
    }


def test_invalid_lodging_preserves_other_known_costs():
    result = draft(
        snapshot(), [{"kind": "move", "entryId": "stay", "day": 4, "slot": "evening"}]
    )
    assert not result.canApply
    assert {"INVALID_LODGING", "BUDGET_INVALID"} <= codes(result)
    assert result.budget.knownMinor == 130000
    assert result.budget.withinBudget is None


def test_overlapping_audiences_reject_but_disjoint_audiences_work():
    value = snapshot()
    change = [{"kind": "move", "entryId": "transfer", "day": 2, "slot": "morning"}]
    assert "OVERLAP" in codes(draft(value, change))
    value["entries"][1]["item"]["audience"] = "divers"
    value["entries"][2]["item"]["audience"] = "non-divers"
    assert draft(value, change).canApply


def test_unknown_and_exclusions_warn_without_blocking():
    value = snapshot()
    value["entries"][1]["item"]["price"].update(unitMinor=None, unknownReason="待確認")
    value["exclusions"] = ["餐費"]
    result = draft(value, [])
    assert result.canApply
    assert codes(result) == {"UNKNOWN_COST", "EXCLUDED_COST"}
    assert result.budget.withinBudget is None


def test_known_over_budget_blocks_even_with_unknown_prices():
    value = snapshot()
    value["requirements"]["budgetMinor"] = 300000
    value["entries"][1]["item"]["price"].update(unitMinor=None, unknownReason="待確認")
    result = draft(value, [])
    assert not result.canApply
    assert {"BUDGET_EXCEEDED", "UNKNOWN_COST"} == codes(result)
