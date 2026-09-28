"""Evidence is built by server operations, never deserialized from model output."""

import hashlib
import json
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import model_validator

from dive_trip.modules.catalog.public import CatalogItem, Destination
from dive_trip.modules.trips.public import ProposalDraft, Snapshot
from dive_trip.platform.schema import WireModel

from .answer_contract import Id, Receipt, Version


class Binding(WireModel):
    ownerId: str
    tripId: str
    runId: str
    baseVersion: Version

    @model_validator(mode="after")
    def identities(self) -> "Binding":
        for value in (self.ownerId, self.tripId, self.runId):
            UUID(value)
        return self


def hash_tuple(values: list[object]) -> str:
    return hashlib.sha256(
        json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


Kind = Literal[
    "requirements",
    "destinations",
    "items",
    "budget",
    "validation",
    "proposal",
    "receipt",
]


def evidence_identity(binding: Binding, kind: Kind, origin: str) -> str:
    if not 1 <= len(origin) <= 128:
        raise ValueError("invalid evidence origin")
    return "ev_" + hash_tuple(
        [
            binding.ownerId,
            binding.tripId,
            binding.runId,
            binding.baseVersion,
            kind,
            origin,
        ]
    )


@dataclass(frozen=True, kw_only=True)
class Evidence:
    binding: Binding
    kind: Kind
    origin: Id
    snapshot: Snapshot | None = None
    catalog: tuple[CatalogItem, ...] = ()
    destination: Destination | None = None
    total: int = 0
    draft: ProposalDraft | None = None
    validation_ref: str | None = None
    receipt: Receipt | None = None

    @property
    def id(self) -> str:
        return evidence_identity(self.binding, self.kind, self.origin)


@dataclass(frozen=True)
class Compilation:
    binding: Binding
    event_id: str
    evidence: tuple[Evidence, ...]

    def resolve(self) -> tuple[dict[str, Evidence], Evidence | None]:
        all_evidence: dict[str, Evidence] = {}
        receipts: list[Evidence] = []
        latest: Evidence | None = None
        for evidence in self.evidence:
            if evidence.binding != self.binding or evidence.id in all_evidence:
                raise ValueError("AGENT_ANSWER_EVIDENCE")
            all_evidence[evidence.id] = evidence
            if evidence.kind == "validation":
                latest = evidence
            elif evidence.kind == "receipt":
                receipts.append(evidence)
        if len(receipts) > 1:
            raise ValueError("AGENT_ANSWER_EVIDENCE")
        return {
            key: evidence
            for key, evidence in all_evidence.items()
            if (evidence.kind != "validation" or evidence is latest)
            and (
                evidence.kind != "proposal"
                or (latest is not None and evidence.validation_ref == latest.id)
            )
        }, receipts[0] if receipts else None
