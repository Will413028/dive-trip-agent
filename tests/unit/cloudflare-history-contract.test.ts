import { expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', () => { throw new Error('identity contract imported filesystem IO'); });
import { cloudflareHistoryProfileSchema } from '../../evals/cloudflare-history-contract';
import { PUBLIC_HISTORY } from '../../evals/cloudflare-history-public';

test('public examples are an instance of the independent versioned identity contract', () => {
  const fixture = { schemaVersion: 1, identities: PUBLIC_HISTORY };
  expect(cloudflareHistoryProfileSchema.parse(fixture)).toEqual(fixture);
  expect(cloudflareHistoryProfileSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(false);
  expect(cloudflareHistoryProfileSchema.safeParse({ ...fixture, identities: {
    ...PUBLIC_HISTORY, accountId_1: PUBLIC_HISTORY.carry_forward_runIds_1,
  } }).success).toBe(false);
});
