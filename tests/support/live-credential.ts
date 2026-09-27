import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';

/** No evaluation, process.env mutation, logging, model selection or env writes. */
export function parseLiveCredential(source: string): string {
  try {
    const values = parseEnv(source);
    const key = values.GEMINI_API_KEY;
    if (!key || key !== key.trim() || /[\r\n\0]/.test(key) || key.length > 4096) throw new Error();
    return key;
  } catch { throw new Error('LIVE_CREDENTIAL_INVALID'); }
}

/** Only an explicitly authorized opt-in smoke may call this. Never ordinary tests. */
export async function loadLiveCredential(authorized: boolean): Promise<string> {
  if (!authorized) throw new Error('LIVE_AUTHORIZATION_REQUIRED');
  try {
    const file = await open(new URL('../../.env.local', import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0) throw new Error();
      return parseLiveCredential(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch { throw new Error('LIVE_CREDENTIAL_UNAVAILABLE'); }
}
