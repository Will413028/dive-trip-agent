import { z } from 'zod';
import { RECOVERY_REPORT_SHA256 } from './cloudflare-artifacts.ts';

/** Fixed historical summary only; importing this schema performs no IO. */
export const recoveryCarrySchema = () => (z.strictObject({ sourceSha256: z.literal(RECOVERY_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(2), invocations: z.literal(41), modelCalls: z.literal(59), chargedMicros: z.literal(398484),
  observedTokens: z.literal(272473), totalTokens: z.null(), remainingInvocationCeiling: z.literal(59), remainingReferenceMicros: z.literal(2601516) }));
