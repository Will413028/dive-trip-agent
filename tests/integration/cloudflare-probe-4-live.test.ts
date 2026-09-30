import { test } from 'vitest';
import { PROBE_4_AUTHORIZATION, runCloudflareProbe4Entry } from '../../evals/cloudflare-probe-4-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_4_AUTHORIZATION === PROBE_4_AUTHORIZATION;
test.skipIf(!authorized)('fourth Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe4Entry);
