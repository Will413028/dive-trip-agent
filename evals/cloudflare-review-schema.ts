import { z } from 'zod';

/** Shared data contract only; importing it never polls files or acquires a lock. */
export const reviewSchema = z.strictObject({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.uuid(), textReview: z.enum(['passed', 'failed']),
  reviewers: z.tuple([z.literal('primary'), z.literal('independent')]),
  findings: z.array(z.string().min(1)).max(20) });
