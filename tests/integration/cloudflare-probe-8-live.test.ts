import { test } from 'vitest';
import { PROBE_8_AUTHORIZATION, runCloudflareProbe8Entry } from '../../evals/cloudflare-probe-8-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_8_AUTHORIZATION === PROBE_8_AUTHORIZATION;
test.skipIf(!authorized)('seventh Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbe8Entry);
