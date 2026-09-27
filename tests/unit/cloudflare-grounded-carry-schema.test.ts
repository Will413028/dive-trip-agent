import { expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', () => { throw new Error('schema imported filesystem IO'); });
vi.mock('pg', () => { throw new Error('schema imported database IO'); });
vi.mock('../../evals/cloudflare-grounded-carry', () => { throw new Error('schema imported history IO'); });

test('grounded summary is a strict data-only schema with no IO or dispatch capability', async () => {
  const { groundedCarrySchema } = await import('../../evals/cloudflare-grounded-carry-schema');
  const { GROUNDED_REPORT_SHA256 } = await import('../../evals/cloudflare-artifacts');
  const summary = { sourceSha256: GROUNDED_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 3, invocations: 42, modelCalls: 60, chargedMicros: 581989,
    observedTokens: 277874, totalTokens: null, remainingInvocationCeiling: 58, remainingReferenceMicros: 2418011 };
  expect(groundedCarrySchema().parse(summary)).toEqual(summary);
  for (const [key, value] of Object.entries(summary)) {
    const changed = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : value === null ? 277874 : '0'.repeat(64);
    expect(groundedCarrySchema().safeParse({ ...summary, [key]: changed }).success, key).toBe(false);
    const missing = { ...summary }; Reflect.deleteProperty(missing, key);
    expect(groundedCarrySchema().safeParse(missing).success, key).toBe(false);
  }
  expect(groundedCarrySchema().safeParse({ ...summary, live: true }).success).toBe(false);
});
