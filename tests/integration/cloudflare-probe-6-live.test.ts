import { test } from 'vitest';
import { PROBE_6_AUTHORIZATION, runCloudflareProbe6Entry } from '../../evals/cloudflare-probe-6-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_6_AUTHORIZATION === PROBE_6_AUTHORIZATION;
test.skipIf(!authorized)('sixth Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe6Entry);
