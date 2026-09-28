"""Version-one answer contract. Model output contains intent and references only."""

import json
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import Field, model_validator

from dive_trip.modules.catalog.public import Destination
from dive_trip.platform.schema import (
    CalendarDate,
    NonnegativeInt,
    PositiveInt,
    WireModel,
)

Id = Annotated[str, Field(min_length=1, max_length=128)]
Text = Annotated[str, Field(max_length=4000)]
EvidenceId = Annotated[str, Field(pattern=r"^ev_[a-f0-9]{64}$")]
Version = Annotated[PositiveInt, Field(le=2147483647)]
ClarificationField = Literal[
    "destination",
    "dates",
    "people",
    "divers",
    "budget",
    "lodging",
    "rooms",
    "pace",
    "target-item",
]


class Clarify(WireModel):
    kind: Literal["clarify"]
    fields: Annotated[list[ClarificationField], Field(min_length=1, max_length=9)]

    @model_validator(mode="after")
    def unique(self) -> Self:
        if len(set(self.fields)) != len(self.fields):
            raise ValueError("duplicate fields")
        return self


class Unsupported(WireModel):
    kind: Literal["unsupported"]
    reason: Literal["outside-scope", "booking", "payment", "safety-guarantee"]


class EvidencePlan(WireModel):
    kind: Literal[
        "requirements", "destinations", "budget", "conflict", "proposal", "receipt"
    ]
    evidenceRef: EvidenceId


class ItemsPlan(WireModel):
    kind: Literal["items"]
    evidenceRef: EvidenceId
    itemIds: Annotated[list[Id], Field(max_length=20)]

    @model_validator(mode="after")
    def unique(self) -> Self:
        if len(set(self.itemIds)) != len(self.itemIds):
            raise ValueError("duplicate items")
        return self


class ComparisonPlan(WireModel):
    kind: Literal["compare-budget"]
    currentRef: EvidenceId
    candidateRef: EvidenceId


class AnswerPlan(WireModel):
    version: Literal["1"]
    answer: Annotated[
        Clarify | Unsupported | EvidencePlan | ItemsPlan | ComparisonPlan,
        Field(discriminator="kind"),
    ]


class Money(WireModel):
    minor: NonnegativeInt
    display: Annotated[str, Field(max_length=64)]

    @model_validator(mode="after")
    def canonical(self) -> Self:
        if self.display != f"TWD {self.minor // 100}.{self.minor % 100:02d}":
            raise ValueError("invalid money display")
        return self


def money(minor: int) -> Money:
    return Money(minor=minor, display=f"TWD {minor // 100}.{minor % 100:02d}")


class SourceView(WireModel):
    id: Id
    url: str | None
    checkedAt: CalendarDate
    kind: Literal["fact", "demo"]
    label: Annotated[Text, Field(min_length=1)]

    @model_validator(mode="after")
    def https_url(self) -> Self:
        from urllib.parse import urlsplit

        if self.url is not None:
            url = urlsplit(self.url)
            if url.scheme != "https" or not url.netloc:
                raise ValueError("invalid source URL")
        return self


Sources = Annotated[list[SourceView], Field(max_length=128)]


class IssueView(WireModel):
    code: Literal[
        "INVALID_CHANGE",
        "INVALID_ACTOR",
        "LOCKED_ENTRY",
        "INVALID_CATALOG",
        "DUPLICATE_ENTRY",
        "CATALOG_NOT_FOUND",
        "ENTRY_NOT_FOUND",
        "DESTINATION_MISMATCH",
        "DATE_OUT_OF_RANGE",
        "INVALID_LODGING",
        "CAPACITY",
        "OVERLAP",
        "BUDGET_INVALID",
        "BUDGET_EXCEEDED",
        "UNKNOWN_COST",
        "EXCLUDED_COST",
    ]
    entryId: Id | None = None


class UnknownCost(WireModel):
    entryId: Id
    title: Text
    reason: Annotated[Text, Field(min_length=1)]
    source: SourceView
    provenanceSources: Sources


class EntrySource(WireModel):
    entryId: Id
    source: SourceView
    provenanceSources: Sources


class LockedBudget(WireModel):
    status: Literal[
        "unavailable",
        "budget-unspecified",
        "locked-known-cost-exceeds-budget",
        "not-proven-infeasible",
    ]
    known: Money | None
    entryIds: Annotated[list[Id], Field(max_length=128)]
    unknownEntryIds: Annotated[list[Id], Field(max_length=128)] | None


class BudgetView(WireModel):
    scope: Literal["current", "candidate"]
    baseVersion: Version
    known: Money
    target: Money | None
    withinBudget: bool | None
    containsDemo: bool
    unknownCosts: Annotated[list[UnknownCost], Field(max_length=128)]
    exclusions: Annotated[list[Text], Field(max_length=128)]
    issues: Annotated[list[IssueView], Field(max_length=256)]
    sources: Annotated[list[EntrySource], Field(max_length=128)]
    locked: LockedBudget

    @model_validator(mode="after")
    def comparable(self) -> Self:
        if self.withinBudget is not None and (
            self.target is None
            or self.unknownCosts
            or self.exclusions
            or self.withinBudget != (self.known.minor <= self.target.minor)
        ):
            raise ValueError("unproven budget sufficiency")
        return self


class RequirementsView(WireModel):
    destinationId: Destination | None
    days: Annotated[PositiveInt, Field(ge=2, le=7)]
    people: Annotated[PositiveInt, Field(le=6)]
    divers: Annotated[NonnegativeInt, Field(le=6)]
    startDate: CalendarDate | None
    target: Money | None
    lodgingPreference: Text
    pace: Literal["relaxed", "balanced"]

    @model_validator(mode="after")
    def participants(self) -> Self:
        if self.divers > self.people:
            raise ValueError("divers exceed people")
        return self


class RequirementsBody(WireModel):
    kind: Literal["requirements"]
    version: Version
    requirements: RequirementsView


class DestinationView(WireModel):
    id: Destination
    itemCount: NonnegativeInt
    demoItemCount: NonnegativeInt


class DestinationsBody(WireModel):
    kind: Literal["destinations"]
    destinations: Annotated[list[DestinationView], Field(max_length=3)]


class ItemView(WireModel):
    id: Id
    title: Text
    audience: Literal["all", "divers", "non-divers"]
    capacityPerRoom: NonnegativeInt | None
    price: Money | None
    unit: Literal["person", "room-night", "group"]
    unknownReason: Text | None
    containsDemo: bool
    source: SourceView
    provenanceSources: Sources

    @model_validator(mode="after")
    def unknown(self) -> Self:
        if (self.price is None) != (self.unknownReason is not None):
            raise ValueError("missing unknown price reason")
        return self


class ItemsBody(WireModel):
    kind: Literal["items"]
    destinationId: Destination
    items: Annotated[list[ItemView], Field(max_length=20)]
    total: NonnegativeInt
    omittedCount: NonnegativeInt

    @model_validator(mode="after")
    def count(self) -> Self:
        if len(self.items) + self.omittedCount != self.total:
            raise ValueError("invalid item count")
        return self


class BudgetBody(WireModel):
    kind: Literal["budget", "conflict"]
    budget: BudgetView


class ComparisonBody(WireModel):
    kind: Literal["compare-budget"]
    current: BudgetView
    candidate: BudgetView

    @model_validator(mode="after")
    def scopes(self) -> Self:
        if (
            self.current.scope != "current"
            or self.candidate.scope != "candidate"
            or self.current.baseVersion != self.candidate.baseVersion
        ):
            raise ValueError("invalid comparison scopes")
        return self


class ProposalBody(WireModel):
    kind: Literal["proposal"]
    proposalRef: EvidenceId
    changeCount: NonnegativeInt
    budget: BudgetView


class Receipt(WireModel):
    status: Literal["applied", "rejected"]
    version: Version


class ReceiptBody(Receipt):
    kind: Literal["receipt"]


class FailureBody(WireModel):
    kind: Literal["failure"]
    reason: Literal["invalid-answer", "incomplete-run", "unsupported-version"]
    committed: Receipt | None


Body = Annotated[
    Clarify
    | Unsupported
    | RequirementsBody
    | DestinationsBody
    | ItemsBody
    | BudgetBody
    | ComparisonBody
    | ProposalBody
    | ReceiptBody
    | FailureBody,
    Field(discriminator="kind"),
]


class AcceptedAnswer(WireModel):
    schemaVersion: Literal[1]
    templateVersion: Literal[1]
    answerId: Annotated[str, Field(pattern=r"^ans_[a-f0-9]{64}$")]
    runId: str
    evidenceRefs: Annotated[list[EvidenceId], Field(max_length=4)]
    body: Body

    @model_validator(mode="before")
    @classmethod
    def integer_versions(cls, value: Any) -> Any:
        if isinstance(value, dict) and any(
            type(value.get(key)) is not int
            for key in ("schemaVersion", "templateVersion")
        ):
            raise ValueError("invalid version")
        return value

    @model_validator(mode="after")
    def wire_valid(self) -> Self:
        UUID(self.runId)
        if type(self.schemaVersion) is not int or type(self.templateVersion) is not int:
            raise ValueError("invalid version")
        if (
            len(
                json.dumps(
                    self.wire(), ensure_ascii=False, separators=(",", ":")
                ).encode()
            )
            > 32000
        ):
            raise ValueError("answer exceeds public byte limit")
        return self

    def wire(self) -> dict[str, object]:
        value = self.model_dump(mode="json")
        # Only optional issue identifiers are absent; nullable prices stay null.
        for budget_key in ("budget", "current", "candidate"):
            for issue in value["body"].get(budget_key, {}).get("issues", []):
                if issue["entryId"] is None:
                    del issue["entryId"]
        return value
