"""Strict commands. Ownership and actor are supplied by the application."""

from typing import Annotated, Any, Literal

from pydantic import Field, TypeAdapter

from dive_trip.platform.schema import Nonempty, PositiveInt, WireModel

from .domain import Requirements, Slot


class RequirementsChange(WireModel):
    kind: Literal["requirements"]
    value: Requirements


class NewEntry(WireModel):
    id: Nonempty
    catalogId: Nonempty
    day: PositiveInt
    slot: Slot
    endDay: PositiveInt | None
    rooms: PositiveInt | None


class AddChange(WireModel):
    kind: Literal["add"]
    entry: NewEntry


class RemoveChange(WireModel):
    kind: Literal["remove"]
    entryId: Nonempty


class MoveChange(WireModel):
    kind: Literal["move"]
    entryId: Nonempty
    day: PositiveInt
    slot: Slot


class ReplaceChange(WireModel):
    kind: Literal["replace"]
    entryId: Nonempty
    catalogId: Nonempty


class RoomsChange(WireModel):
    kind: Literal["rooms"]
    entryId: Nonempty
    rooms: PositiveInt


class LockChange(WireModel):
    kind: Literal["lock"]
    entryId: Nonempty
    locked: bool


Change = Annotated[
    RequirementsChange
    | AddChange
    | RemoveChange
    | MoveChange
    | ReplaceChange
    | RoomsChange
    | LockChange,
    Field(discriminator="kind"),
]
_changes = TypeAdapter(list[Change])


def parse_changes(value: Any) -> list[Change]:
    return _changes.validate_python(value, strict=True)
