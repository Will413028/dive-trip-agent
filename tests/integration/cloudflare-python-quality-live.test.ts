import { test } from 'vitest';
import { PYTHON_QUALITY_AUTHORIZATION, runCloudflarePythonQualityEntry } from '../../evals/cloudflare-python-quality-entry.ts';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PYTHON_QUALITY_AUTHORIZATION === PYTHON_QUALITY_AUTHORIZATION;
test.skipIf(!authorized)('new Free-only Python quality campaign: two reviewed plus twenty-eight cases',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, runCloudflarePythonQualityEntry);
