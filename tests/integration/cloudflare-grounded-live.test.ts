import { test } from 'vitest';
import { runCloudflareGroundedEntry, GROUNDED_AUTHORIZATION } from '../../evals/cloudflare-grounded-entry';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_GROUNDED_AUTHORIZATION === GROUNDED_AUTHORIZATION;
test.skipIf(!authorized)('grounded answers: two included preflights then 28 cases once, 210 calls / 39 dispatches',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, runCloudflareGroundedEntry);
