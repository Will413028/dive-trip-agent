import { recoveryCarrySchema } from '../../evals/cloudflare-recovery-carry-schema';
import { RECOVERY_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';

/** Fixed synthetic carry only, never a DB/report audit or authority to dispatch. */
export const groundedPrior = () => recoveryCarrySchema().parse({ sourceSha256: RECOVERY_REPORT_SHA256(),
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 2, invocations: 41, modelCalls: 59, chargedMicros: 398484,
  observedTokens: 272473, totalTokens: null, remainingInvocationCeiling: 59, remainingReferenceMicros: 2601516 });
