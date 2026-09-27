import type { RecordedEvaluationV2 } from '../../evals/collector';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidenceV2 as gradeEvidence, type RunEvidenceV2 as RunEvidence } from '../../evals/evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

// Synthetic projection only: never reads a historical artifact, environment or credential.
export const recoveryPrior = {
  sourceSha256: '1f3713e89e71eb0e918f7e7a7c155133f6c4d92f6bce198d361f3d7761562cc9',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 2, invocations: 39, modelCalls: 56, chargedMicros: 396708,
  observedTokens: 259078, totalTokens: null, remainingInvocationCeiling: 61, remainingReferenceMicros: 2603292,
} as const;
export const recoveryAccount = '1fd574e905257afa3cfd7db80cf70b23';

export function recoveryResult(caseId: string, attempt: number, patch: Partial<RunEvidence> = {}): RecordedEvaluationV2 {
  const input = evaluationInput(caseId);
  const proposal = input.terminal === 'proposal';
  const runId = `synthetic-${caseId}-${attempt}`;
  const after = structuredClone(input.before);
  if (caseId === 'free-afternoon') after.entries = after.entries.filter(entry => entry.id !== 'transfer');
  if (caseId === 'non-diver') after.requirements.divers = 0;
  if (caseId === 'more-people') { after.requirements.people = 3; after.entries[0].rooms = 2; }
  const evidence: RunEvidence = {
    caseId, inputDigest: input.digest, runId, before: input.before,
    beforeDecision: structuredClone(input.before), after, beforeVersion: 1, beforeDecisionVersion: 1,
    afterVersion: proposal ? 2 : 1, terminal: input.terminal as RunEvidence['terminal'], runStatus: 'succeeded',
    decision: proposal ? 'accept' : 'none', proposalId: proposal ? 'synthetic-proposal' : null,
    decisionRunId: proposal ? runId : null, decisionProposalId: proposal ? 'synthetic-proposal' : null,
    model: CLOUDFLARE_MODEL, usageRunId: runId, usageComplete: true,
    modelCalls: 2, toolCount: 2, visibleToolCount: 1, costMicros: 100, latencyMs: 1000, textReview: 'pending',
    faultObserved: input.fault, ...patch,
  };
  // Scheduler stub only, not an AcceptedAnswer/replay fixture or historical upgrade.
  return { schemaVersion: 2, evidence, events: [], grade: gradeEvidence(evidence, CLOUDFLARE_MODEL) };
}
