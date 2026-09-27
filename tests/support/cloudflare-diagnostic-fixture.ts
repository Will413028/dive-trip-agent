import { nonthinkingCarrySchema } from '../../evals/cloudflare-nonthinking-carry-schema.ts';
import { NONTHINKING_REPORT_SHA256 } from '../../evals/cloudflare-artifacts.ts';

/** Fixed historical counters, not dispatch authority or newly settled usage. */
export function diagnosticPrior() {
  return nonthinkingCarrySchema().parse({ sourceSha256: NONTHINKING_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 4,
    invocations: 43, modelCalls: 61, chargedMicros: 765494, observedTokens: 277874, totalTokens: null,
    remainingInvocationCeiling: 57, remainingReferenceMicros: 2234506 });
}
