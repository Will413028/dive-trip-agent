import { z } from 'zod';
import { REVISION_REPORT_SHA256 } from './cloudflare-artifacts.ts';

/** Fixed historical summary only; importing this schema performs no IO. */
export const revisionCarrySchema = () => (z.strictObject({ sourceSha256: z.literal(REVISION_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(2), invocations: z.literal(39), modelCalls: z.literal(56), chargedMicros: z.literal(396708),
  observedTokens: z.literal(259078), totalTokens: z.null(), remainingInvocationCeiling: z.literal(61), remainingReferenceMicros: z.literal(2603292) }));
