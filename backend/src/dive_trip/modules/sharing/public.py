"""Fixed publication contract: construct explicit fields, never spread a trip."""

import hashlib
import json
from typing import Annotated, Literal

from pydantic import Field

from dive_trip.modules.catalog.public import CatalogItem, Destination
from dive_trip.modules.trips.public import Snapshot, budget_model
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import (
    CalendarDate,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)


class SharedBudget(WireModel):
    knownMinor: NonnegativeInt
    limitMinor: NonnegativeInt | None
    unknownCount: NonnegativeInt
    exclusionsCount: NonnegativeInt


class SharedPrice(WireModel):
    unit: Literal["person", "room-night", "group"]
    unitMinor: NonnegativeInt | None
    basis: Literal["estimate", "demo"]


class SharedSource(WireModel):
    url: str | None
    label: str
    checkedAt: CalendarDate
    kind: Literal["fact", "demo"]


class SharedEntry(WireModel):
    day: PositiveInt
    slot: Literal["morning", "afternoon", "evening"]
    endDay: PositiveInt | None
    rooms: PositiveInt | None
    title: str
    kind: Literal["lodging", "activity"]
    demo: bool
    sourceVerified: bool
    price: SharedPrice
    sources: list[SharedSource]


class PublicTrip(WireModel):
    destinationId: Destination | None
    days: Annotated[PositiveInt, Field(ge=2, le=7)]
    people: Annotated[PositiveInt, Field(le=6)]
    budget: SharedBudget
    entries: Annotated[list[SharedEntry], Field(max_length=128)]


def preview_share(snapshot: Snapshot, catalog: list[CatalogItem]) -> PublicTrip:
    if len(snapshot.entries) > 128:
        raise DomainError("SHARE_TOO_LARGE")
    budget = budget_model(snapshot)
    trusted = {item.id: item for item in catalog}
    entries = []
    for entry in snapshot.entries:
        item = trusted.get(entry.catalogId)
        verified = item == entry.item
        entries.append(
            SharedEntry(
                day=entry.day,
                slot=entry.slot,
                endDay=entry.endDay,
                rooms=entry.rooms,
                title=item.title
                if verified and item
                else "封存行程項目（來源待重新確認）",
                kind=entry.item.kind,
                demo=entry.item.price.basis == "demo"
                or any(source.kind == "demo" for source in entry.item.sources),
                sourceVerified=verified,
                price=SharedPrice(
                    unit=entry.item.price.unit,
                    unitMinor=entry.item.price.unitMinor,
                    basis=entry.item.price.basis,
                ),
                sources=[
                    SharedSource(
                        url=source.url,
                        label=source.label,
                        checkedAt=source.checkedAt,
                        kind=source.kind,
                    )
                    for source in item.sources
                ]
                if verified and item
                else [],
            )
        )
    result = PublicTrip(
        destinationId=snapshot.requirements.destinationId,
        days=snapshot.requirements.days,
        people=snapshot.requirements.people,
        budget=SharedBudget(
            knownMinor=budget.knownMinor,
            limitMinor=snapshot.requirements.budgetMinor,
            unknownCount=len(budget.unknownEntryIds),
            exclusionsCount=len(snapshot.exclusions),
        ),
        entries=entries,
    )
    if len(result.model_dump_json().encode()) > 65536:
        raise DomainError("SHARE_TOO_LARGE")
    return result


def hash_preview(preview: PublicTrip) -> str:
    canonical = json.dumps(
        preview.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()
