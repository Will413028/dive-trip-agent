import pytest
from test_budget import snapshot

from dive_trip.modules.trips.agent_changes import expand_agent_changes
from dive_trip.modules.trips.domain import Snapshot


def test_ordered_patch_uses_bound_base_and_explicit_null_only():
    base = Snapshot.model_validate(snapshot())
    result = expand_agent_changes(
        base,
        [
            {"kind": "requirements", "value": {"days": 5}},
            {"kind": "requirements", "value": {"budgetMinor": None}},
        ],
    )
    assert result[0].value.days == 5
    assert result[0].value.budgetMinor == 1000000
    assert result[1].value.days == 5
    assert result[1].value.budgetMinor is None
    assert base.requirements.days == 4
    assert base.requirements.budgetMinor == 1000000


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"days": None},
        {"people": True},
        {"days": "5"},
        {"divers": 3},
        {"startDate": "2026-02-30"},
        {"startDate": "2026-2-01"},
        {"actor": "user"},
        {"lodgingPreference": "x" * 501},
    ],
)
def test_bad_patches_rejected(patch):
    with pytest.raises(ValueError):
        expand_agent_changes(
            Snapshot.model_validate(snapshot()),
            [{"kind": "requirements", "value": patch}],
        )


@pytest.mark.parametrize(
    "changes",
    [
        [],
        [{"kind": "lock", "entryId": "stay", "locked": False}],
        [{"kind": "remove", "entryId": "x\0y"}],
    ],
)
def test_agent_cannot_unlock_or_supply_invalid_commands(changes):
    with pytest.raises(ValueError):
        expand_agent_changes(Snapshot.model_validate(snapshot()), changes)
