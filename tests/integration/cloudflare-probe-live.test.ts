import { test } from 'vitest';
import { PROBE_AUTHORIZATION, runCloudflareProbeEntry } from '../../evals/cloudflare-probe-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PROBE_AUTHORIZATION === PROBE_AUTHORIZATION;
test.skipIf(!authorized)('Free-only unknown-cost technical probe: one invocation, seven calls at most',
  { timeout: 300_000, retry: 0, repeats: 0 }, runCloudflareProbeEntry);
