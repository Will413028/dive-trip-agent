import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { database } from './db';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  await database().query('INSERT INTO sessions (id, token_hash) VALUES ($1, $2)', [id, tokenHash(token)]);
  return { id, token };
}

export async function resolveSession(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const result = await database().query<{ id: string }>(
    'SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [tokenHash(token)],
  );
  return result.rows[0]?.id ?? null;
}
