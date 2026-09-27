import { expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', () => { throw new Error('schema imported filesystem IO'); });
vi.mock('pg', () => { throw new Error('schema imported database IO'); });
vi.mock('../../evals/cloudflare-nonthinking-carry', () => { throw new Error('schema imported history IO'); });

test('nonthinking summary is a strict data-only schema with no IO or dispatch capability', async () => {
  const { nonthinkingCarrySchema } = await import('../../evals/cloudflare-nonthinking-carry-schema');
  const { NONTHINKING_REPORT_SHA256 } = await import('../../evals/cloudflare-artifacts');
  const summary = { sourceSha256: NONTHINKING_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 4, invocations: 43, modelCalls: 61, chargedMicros: 765494,
    observedTokens: 277874, totalTokens: null, remainingInvocationCeiling: 57, remainingReferenceMicros: 2234506 };
  expect(nonthinkingCarrySchema().parse(summary)).toEqual(summary);
  for (const [key, value] of Object.entries(summary)) {
    const changed = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : value === null ? 277874 : '0'.repeat(64);
    expect(nonthinkingCarrySchema().safeParse({ ...summary, [key]: changed }).success, key).toBe(false);
    const missing = { ...summary }; Reflect.deleteProperty(missing, key);
    expect(nonthinkingCarrySchema().safeParse(missing).success, key).toBe(false);
  }
  expect(nonthinkingCarrySchema().safeParse({ ...summary, live: true }).success).toBe(false);
});
