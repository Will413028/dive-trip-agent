"""Server-owned proposal presentation, computed from the immutable base version."""

from typing import Any

from dive_trip.platform.schema import SafeInt, WireModel

from .diff import diff_snapshots
from .domain import Snapshot, budget_model
from .proposal import ProposalDraft


class Difference(WireModel):
    path: str
    before: Any = None
    after: Any = None


class ProposalReview(WireModel):
    differences: list[Difference]
    knownDeltaMinor: SafeInt


def review_proposal(base: Snapshot, draft: ProposalDraft) -> dict[str, Any]:
    review = ProposalReview(
        differences=[
            Difference.model_validate(row) for row in diff_snapshots(base, draft.next)
        ],
        knownDeltaMinor=draft.budget.knownMinor - budget_model(base).knownMinor,
    )
    # Missing is distinct from an explicit null price/date in a difference.
    return review.model_dump(mode="json", exclude_unset=True)
