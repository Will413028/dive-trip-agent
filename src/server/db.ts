import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';

const scopedDatabase = new AsyncLocalStorage<Pool>();
let applicationPool: Pool | undefined;

export function makePool(connectionString: string, schema = 'public'): Pool {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_DATABASE_SCHEMA');
  const pool = new Pool({
    connectionString, max: 5, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10_000, statement_timeout: 10_000,
    options: `-c search_path=${schema}`,
  });
  // Idle client errors are not request errors. Never log connection strings.
  pool.on('error', () => { console.error('DATABASE_IDLE_CONNECTION_ERROR'); });
  return pool;
}

export function database(): Pool {
  const scoped = scopedDatabase.getStore();
  if (scoped) return scoped;
  if (!applicationPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL_REQUIRED');
    applicationPool = makePool(url);
  }
  return applicationPool;
}

export function withDatabasePool<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  return scopedDatabase.run(pool, work);
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
