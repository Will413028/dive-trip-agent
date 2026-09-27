import { test } from 'vitest';
import { runCloudflareDiagnosticEntry, DIAGNOSTIC_AUTHORIZATION } from '../../evals/cloudflare-diagnostic-entry';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_DIAGNOSTIC_AUTHORIZATION === DIAGNOSTIC_AUTHORIZATION;
test.skipIf(!authorized)('diagnostic two included cases then 28: 210 calls / 39 dispatches, no retry',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, runCloudflareDiagnosticEntry);
