"""Product assertions use literal totals, independent of the implementation."""

from copy import deepcopy

import pytest

from dive_trip.modules.trips.public import calculate_budget


def snapshot():
    def item(key, unit, amount):
        return {
            "id": key,
            "destinationId": "xiaoliuqiu",
            "kind": "lodging" if unit == "room-night" else "activity",
            "title": f"DEMO 示範 {key}",
            "audience": "all",
            "capacityPerRoom": 2 if unit == "room-night" else None,
            "lat": None,
            "lng": None,
            "price": {
                "unit": unit,
                "unitMinor": amount,
                "basis": "demo",
                "sourceId": "demo",
                "unknownReason": None,
            },
            "sources": [
                {
                    "id": "demo",
                    "url": None,
                    "checkedAt": "2026-09-19",
                    "kind": "demo",
                    "label": "DEMO 示範資料，非真實報價",
                }
            ],
        }

    return {
        "requirements": {
            "destinationId": "xiaoliuqiu",
            "days": 4,
            "people": 2,
            "divers": 1,
            "startDate": None,
            "budgetMinor": 1000000,
            "lodgingPreference": "示範雙人房",
            "pace": "balanced",
        },
        "entries": [
            {
                "id": "stay",
                "catalogId": "stay",
                "day": 1,
                "slot": "evening",
                "endDay": 4,
                "rooms": 1,
                "locked": False,
                "item": item("stay", "room-night", 100000),
            },
            {
                "id": "tour",
                "catalogId": "tour",
                "day": 2,
                "slot": "morning",
                "endDay": None,
                "rooms": None,
                "locked": False,
                "item": item("tour", "person", 50000),
            },
            {
                "id": "transfer",
                "catalogId": "transfer",
                "day": 2,
                "slot": "afternoon",
                "endDay": None,
                "rooms": None,
                "locked": False,
                "item": item("transfer", "group", 30000),
            },
        ],
        "exclusions": [],
    }


def test_known_subtotal_does_not_treat_unknown_price_as_free():
    value = snapshot()
    assert calculate_budget(value) == {
        "knownMinor": 430000,
        "unknownEntryIds": [],
        "withinBudget": True,
    }
    value["entries"][1]["item"]["price"].update(
        unitMinor=None, unknownReason="待業者確認"
    )
    before = deepcopy(value)
    assert calculate_budget(value) == {
        "knownMinor": 330000,
        "unknownEntryIds": ["tour"],
        "withinBudget": None,
    }
    assert value == before


@pytest.mark.parametrize(
    "people,divers,audience,total",
    [
        (3, 1, "all", 150000),
        (3, 1, "divers", 50000),
        (3, 1, "non-divers", 100000),
        (2, 0, "divers", 0),
    ],
)
def test_person_price_uses_relevant_participants(people, divers, audience, total):
    value = snapshot()
    value["entries"] = [value["entries"][1]]
    value["entries"][0]["item"]["audience"] = audience
    value["requirements"].update(people=people, divers=divers)
    assert calculate_budget(value)["knownMinor"] == total


def test_room_nights_are_not_people_or_total_trip_days():
    value = snapshot()
    value["entries"] = [value["entries"][0]]
    value["entries"][0].update(rooms=2, day=2, endDay=4)
    value["requirements"]["people"] = 4
    assert calculate_budget(value)["knownMinor"] == 400000


@pytest.mark.parametrize(
    "amount,expected", [(430000, True), (429999, False), (None, None)]
)
def test_budget_boundary(amount, expected):
    value = snapshot()
    value["requirements"]["budgetMinor"] = amount
    assert calculate_budget(value)["withinBudget"] is expected


def test_unknown_zero_participant_cost_and_exclusions():
    value = snapshot()
    value["entries"] = [value["entries"][1]]
    value["entries"][0]["item"].update(audience="divers")
    value["entries"][0]["item"]["price"].update(unitMinor=None, unknownReason="未知")
    value["requirements"]["divers"] = 0
    assert calculate_budget(value) == {
        "knownMinor": 0,
        "unknownEntryIds": [],
        "withinBudget": True,
    }
    value["exclusions"] = ["餐費"]
    assert calculate_budget(value)["withinBudget"] is None


@pytest.mark.parametrize("bad", [True, "2", 0, 7, 1.5, None])
def test_requirements_reject_invalid_people(bad):
    value = snapshot()
    value["requirements"]["people"] = bad
    with pytest.raises(ValueError):
        calculate_budget(value)


def test_unknown_price_still_checks_capacity_and_integer_overflow():
    value = snapshot()
    value["requirements"]["people"] = 3
    value["entries"][0]["item"]["price"].update(unitMinor=None, unknownReason="未知")
    with pytest.raises(ValueError):
        calculate_budget(value)
    value = snapshot()
    value["entries"][1]["item"]["price"]["unitMinor"] = 9007199254740991
    with pytest.raises(ValueError):
        calculate_budget(value)
