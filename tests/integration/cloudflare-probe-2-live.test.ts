import { test } from 'vitest';
import { PROBE_2_AUTHORIZATION, runCloudflareProbe2Entry } from '../../evals/cloudflare-probe-2-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_2_AUTHORIZATION === PROBE_2_AUTHORIZATION;
test.skipIf(!authorized)('second Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe2Entry);
