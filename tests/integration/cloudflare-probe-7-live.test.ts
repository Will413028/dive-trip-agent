import { test } from 'vitest';
import { PROBE_7_AUTHORIZATION, runCloudflareProbe7Entry } from '../../evals/cloudflare-probe-7-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_7_AUTHORIZATION === PROBE_7_AUTHORIZATION;
test.skipIf(!authorized)('seventh Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe7Entry);
