import { expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', () => { throw new Error('schema imported filesystem IO'); });
vi.mock('pg', () => { throw new Error('schema imported database IO'); });
vi.mock('../../evals/cloudflare-recovery-carry', () => { throw new Error('schema imported history IO'); });

test('scheduler can import the recovery schema without filesystem, database or history readers', async () => {
  const { recoveryCarrySchema } = await import('../../evals/cloudflare-recovery-carry-schema');
  const { RECOVERY_REPORT_SHA256 } = await import('../../evals/cloudflare-artifacts');
  expect(recoveryCarrySchema().safeParse({ sourceSha256: RECOVERY_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 2, invocations: 41, modelCalls: 59, chargedMicros: 398484,
    observedTokens: 272473, totalTokens: null, remainingInvocationCeiling: 59, remainingReferenceMicros: 2601516 }).success).toBe(true);
});
