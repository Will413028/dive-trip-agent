import { groundedCarrySchema } from '../../evals/cloudflare-grounded-carry-schema.ts';
import { GROUNDED_REPORT_SHA256 } from '../../evals/cloudflare-artifacts.ts';

/** Historical counters only; no credential or dispatch authority. */
export function nonthinkingPrior() {
  return groundedCarrySchema().parse({ sourceSha256: GROUNDED_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 3,
    invocations: 42, modelCalls: 60, chargedMicros: 581989, observedTokens: 277874, totalTokens: null,
    remainingInvocationCeiling: 58, remainingReferenceMicros: 2418011 });
}
