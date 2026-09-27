import { test } from 'vitest';
import { runCloudflareRevisionEntry, REVISION_AUTHORIZATION } from '../../evals/cloudflare-revision-entry';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION === REVISION_AUTHORIZATION;
test.skipIf(!authorized)('non-diver preflight then 30 Cloudflare cases once',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, runCloudflareRevisionEntry);
