import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export function parseLocalCredential(source: string, variable = 'GEMINI_API_KEY'): string {
  try {
    const key = parseEnv(source)[variable];
    if (!key || key !== key.trim() || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error();
    return key;
  } catch { throw new Error('LIVE_CREDENTIAL_UNAVAILABLE'); }
}

export async function loadLocalCredential(provider: 'gemini' | 'openrouter' | 'cloudflare' = 'gemini'): Promise<string> {
  try {
    // Runtime path, not a bundler asset URL. Never read at import/build time.
    const file = await open(resolve(process.cwd(), provider === 'cloudflare' ? '.env.cloudflare.local' : '.env.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0) throw new Error();
      return parseLocalCredential(await file.readFile('utf8'), provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN'
        : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY');
    } finally { await file.close(); }
  } catch { throw new Error('LIVE_CREDENTIAL_UNAVAILABLE'); }
}
