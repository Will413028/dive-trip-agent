import { test } from 'vitest';
import { runCloudflareNonthinkingEntry, NONTHINKING_AUTHORIZATION } from '../../evals/cloudflare-nonthinking-entry';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_NONTHINKING_AUTHORIZATION === NONTHINKING_AUTHORIZATION;
test.skipIf(!authorized)('non-thinking unknown-cost once: 7 calls / 1 start, no resume or other cases',
  { timeout: 360_000, retry: 0, repeats: 0 }, runCloudflareNonthinkingEntry);
