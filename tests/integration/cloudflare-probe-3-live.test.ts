import { test } from 'vitest';
import { PROBE_3_AUTHORIZATION, runCloudflareProbe3Entry } from '../../evals/cloudflare-probe-3-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_3_AUTHORIZATION === PROBE_3_AUTHORIZATION;
test.skipIf(!authorized)('third Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe3Entry);
