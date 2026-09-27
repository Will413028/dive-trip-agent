import type { PoolClient } from 'pg';

/** MikroORM 7.2.1 introspects all schemas, even with a target schema configured.
 * Coordinate SDK bootstrap with our ephemeral-schema DDL, not model execution.
 * Call on one checked-out client, outside a transaction (SDK has its own pool).
 */
export async function withAdkSchemaLock<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock(724917, 0)');
  try { return await work(); }
  finally { await client.query('SELECT pg_advisory_unlock(724917, 0)'); }
}
