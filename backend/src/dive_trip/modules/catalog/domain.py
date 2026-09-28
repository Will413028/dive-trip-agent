from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, TypeAdapter, model_validator

from dive_trip.platform.schema import (
    CalendarDate,
    Nonempty,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)

Destination = Literal["xiaoliuqiu", "green-island", "kenting"]
PriceUnit = Literal["person", "room-night", "group"]


def demo_label(text: str) -> bool:
    return "demo" in text.lower() or "示範" in text


class Source(WireModel):
    id: Nonempty
    url: str | None
    checkedAt: CalendarDate
    kind: Literal["fact", "demo"]
    label: Nonempty

    @model_validator(mode="after")
    def provenance(self) -> Self:
        if self.url is not None:
            parsed = urlsplit(self.url)
            if parsed.scheme != "https" or not parsed.hostname:
                raise ValueError("source must use an HTTPS URL")
        if self.kind == "fact" and self.url is None:
            raise ValueError("fact requires a source URL")
        if self.kind == "demo" and not demo_label(self.label):
            raise ValueError("demo source must be labelled")
        return self


class Price(WireModel):
    unit: PriceUnit
    unitMinor: NonnegativeInt | None
    basis: Literal["estimate", "demo"]
    sourceId: Nonempty
    unknownReason: Nonempty | None

    @model_validator(mode="after")
    def unknown_pair(self) -> Self:
        if (self.unitMinor is None) != (self.unknownReason is not None):
            raise ValueError("unknown price and reason must occur together")
        return self


class CatalogItem(WireModel):
    id: Nonempty
    destinationId: Destination
    kind: Literal["lodging", "activity"]
    title: Nonempty
    audience: Literal["all", "divers", "non-divers"]
    capacityPerRoom: PositiveInt | None
    lat: float | None = Field(ge=-90, le=90)
    lng: float | None = Field(ge=-180, le=180)
    price: Price
    sources: list[Source] = Field(min_length=1)

    @model_validator(mode="after")
    def consistency(self) -> Self:
        if (self.lat is None) != (self.lng is None):
            raise ValueError("coordinates must occur together")
        ids = [source.id for source in self.sources]
        if len(ids) != len(set(ids)) or self.price.sourceId not in ids:
            raise ValueError("source references must be unique and resolvable")
        contains_demo = self.price.basis == "demo" or any(
            source.kind == "demo" for source in self.sources
        )
        if contains_demo and not demo_label(self.title):
            raise ValueError("demo item must be labelled")
        if self.kind == "lodging":
            if self.price.unit != "room-night" or self.capacityPerRoom is None:
                raise ValueError("lodging requires room-night price and capacity")
        elif self.price.unit == "room-night" or self.capacityPerRoom is not None:
            raise ValueError("activity cannot have room price or capacity")
        return self


def load_catalog(value: Any) -> list[CatalogItem]:
    items = TypeAdapter(list[CatalogItem]).validate_python(value, strict=True)
    if len({item.id for item in items}) != len(items):
        raise ValueError("duplicate catalog ID")
    return items
