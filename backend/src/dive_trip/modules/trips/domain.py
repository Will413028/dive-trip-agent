from typing import Any, Literal, Self

from pydantic import Field, model_validator

from dive_trip.modules.catalog.public import CatalogItem, Destination
from dive_trip.platform.schema import (
    CalendarDate,
    Nonempty,
    NonnegativeInt,
    PositiveInt,
    WireModel,
    safe_integer,
)

Slot = Literal["morning", "afternoon", "evening"]


class Requirements(WireModel):
    destinationId: Destination | None
    days: PositiveInt = Field(ge=2, le=7)
    people: PositiveInt = Field(le=6)
    divers: NonnegativeInt
    startDate: CalendarDate | None
    budgetMinor: NonnegativeInt | None
    lodgingPreference: str
    pace: Literal["relaxed", "balanced"]

    @model_validator(mode="after")
    def diver_count(self) -> Self:
        if self.divers > self.people:
            raise ValueError("divers cannot exceed people")
        return self


class Entry(WireModel):
    id: Nonempty
    catalogId: Nonempty
    day: PositiveInt
    slot: Slot
    endDay: PositiveInt | None
    rooms: PositiveInt | None
    locked: bool
    item: CatalogItem


class Snapshot(WireModel):
    requirements: Requirements
    entries: list[Entry]
    exclusions: list[Nonempty]

    @model_validator(mode="after")
    def item_identity(self) -> Self:
        if any(entry.catalogId != entry.item.id for entry in self.entries):
            raise ValueError("SNAPSHOT_ITEM_MISMATCH")
        return self


class Budget(WireModel):
    knownMinor: NonnegativeInt
    unknownEntryIds: list[str]
    withinBudget: bool | None


def participants(entry: Entry, requirements: Requirements) -> int:
    if entry.item.audience == "all":
        return requirements.people
    if entry.item.audience == "divers":
        return requirements.divers
    return requirements.people - requirements.divers


def quantity(entry: Entry, requirements: Requirements) -> int:
    if entry.day > requirements.days:
        raise ValueError("entry day exceeds trip")
    if entry.item.price.unit == "room-night":
        if (
            entry.rooms is None
            or entry.endDay is None
            or entry.endDay <= entry.day
            or entry.endDay > requirements.days
            or entry.item.capacityPerRoom is None
        ):
            raise ValueError("invalid lodging quantity")
        capacity = safe_integer(entry.rooms * entry.item.capacityPerRoom)
        if capacity < participants(entry, requirements):
            raise ValueError("insufficient lodging capacity")
        return safe_integer(entry.rooms * (entry.endDay - entry.day))
    if entry.rooms is not None or entry.endDay is not None:
        raise ValueError("activity cannot have rooms or checkout date")
    if entry.item.price.unit == "group":
        return 1
    return participants(entry, requirements)


def budget_model(snapshot: Snapshot) -> Budget:
    quantities = [
        (entry, quantity(entry, snapshot.requirements)) for entry in snapshot.entries
    ]
    known = 0
    unknown: list[str] = []
    for entry, count in quantities:
        if count == 0:
            continue
        amount = entry.item.price.unitMinor
        if amount is None:
            unknown.append(entry.id)
        else:
            known = safe_integer(known + safe_integer(amount * count))
    limit = snapshot.requirements.budgetMinor
    comparable = limit is not None and not unknown and not snapshot.exclusions
    return Budget(
        knownMinor=known,
        unknownEntryIds=unknown,
        withinBudget=(known <= limit) if comparable and limit is not None else None,
    )


def calculate_budget(value: Any) -> dict[str, Any]:
    return budget_model(Snapshot.model_validate(value)).model_dump(mode="json")
