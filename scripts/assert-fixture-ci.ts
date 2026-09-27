import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Metadata only: no credential values, env-file contents or provider imports.
 * Reject entire namespaces so later live/evaluation flags cannot drift past CI.
 * Even empty values are forbidden; fixture CI must omit these variables. */
export function assertFixtureCi(fileNames: readonly string[], environmentNames: readonly string[]): void {
  if (fileNames.some(name => name.startsWith('.env') && name !== '.env.example')) {
    throw new Error('CI_ENV_FILES_FORBIDDEN');
  }
  if (environmentNames.some(name => name === 'DATABASE_URL'
    || /^(GEMINI|GOOGLE|OPENROUTER|CLOUDFLARE|DIVE_LOCAL|DIVE_TRIP)_/.test(name))) {
    throw new Error('CI_EXTERNAL_CREDENTIALS_FORBIDDEN');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { assertFixtureCi(readdirSync('.'), Object.keys(process.env)); }
  catch { console.error('CI_FIXTURE_BOUNDARY_FAILED'); process.exitCode = 1; }
}
