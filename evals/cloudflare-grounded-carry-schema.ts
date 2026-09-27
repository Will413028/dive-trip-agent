import { z } from 'zod';
import { GROUNDED_REPORT_SHA256 } from './cloudflare-artifacts.ts';

/** Fixed stopped history only; importing this strict schema performs no IO. */
export const groundedCarrySchema = () => (z.strictObject({ sourceSha256: z.literal(GROUNDED_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(3), invocations: z.literal(42), modelCalls: z.literal(60), chargedMicros: z.literal(581989),
  observedTokens: z.literal(277874), totalTokens: z.null(), remainingInvocationCeiling: z.literal(58), remainingReferenceMicros: z.literal(2418011) }));
