import { z } from 'zod';
import { NONTHINKING_REPORT_SHA256 } from './cloudflare-artifacts.ts';

/** Fixed stopped history only; importing this strict schema performs no IO. */
export const nonthinkingCarrySchema = () => (z.strictObject({ sourceSha256: z.literal(NONTHINKING_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(4), invocations: z.literal(43), modelCalls: z.literal(61), chargedMicros: z.literal(765494),
  observedTokens: z.literal(277874), totalTokens: z.null(), remainingInvocationCeiling: z.literal(57), remainingReferenceMicros: z.literal(2234506) }));
