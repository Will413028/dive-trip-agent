import { test } from 'vitest';
import { PROBE_5_AUTHORIZATION, runCloudflareProbe5Entry } from '../../evals/cloudflare-probe-5-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_5_AUTHORIZATION === PROBE_5_AUTHORIZATION;
test.skipIf(!authorized)('fourth Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe5Entry);
