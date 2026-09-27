import { test } from 'vitest';
import { runCloudflareRecoveryEntry, RECOVERY_AUTHORIZATION } from '../../evals/cloudflare-recovery-entry';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION === RECOVERY_AUTHORIZATION;
test.skipIf(!authorized)('two included preflights then 28 Cloudflare cases once',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, runCloudflareRecoveryEntry);
