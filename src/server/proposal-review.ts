// Transitional retired-runtime projection; removed with the ADK writer at cutover.
import type { ProposalReview } from '../contracts/generated';
import type { ProposalDraft, Snapshot } from '../domain/types';
import { diffSnapshots } from '../domain/diff.ts';
import { calculateBudget } from '../domain/budget.ts';

export function reviewProposal(base: Snapshot, draft: ProposalDraft): ProposalReview {
  return { differences: diffSnapshots(base, draft.next),
    knownDeltaMinor: draft.budget.knownMinor - calculateBudget(base).knownMinor };
}
