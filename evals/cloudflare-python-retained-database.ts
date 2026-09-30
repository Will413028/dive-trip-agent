import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type QueryConfig } from 'pg';
import { assertCloudflareAuditPool } from '../tests/support/cloudflare-audit-database.ts';

const invalid = (): never => { throw new Error('CLOUDFLARE_PYTHON_STORAGE_INVALID'); };

/** A single complete bounded raw-row capture. The caller pins the fingerprint
 * and its own expected call count; one extra selected call detects overflow. */
export async function capturePythonRetainedDatabase(pool: Pool, profile: { retainedSchema: string },
  expectedCalls: 1 | 2 | 4) {
  assertCloudflareAuditPool(pool);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const selected = client;
    const query = async (text: string) => (await selected.query({ text, query_timeout: 2000 } as QueryConfig & { query_timeout: number })).rows;
    await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL statement_timeout = '2000ms'");
    const scope = await query('SELECT current_database() AS database,current_schema() AS schema');
    if (scope.length !== 1 || scope[0].database !== 'dive_trip_test' || scope[0].schema !== profile.retainedSchema) invalid();
    const relations = await query("SELECT relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r' ORDER BY relname LIMIT 33");
    if (relations.length !== 22) invalid();
    const hash = createHash('sha256');
    const raw: { name: string; rows: string[] }[] = [];
    let size = 0;
    for (const { relname } of relations) {
      if (typeof relname !== 'string') invalid();
      hash.update(relname + '\0');
      const quoted = `"${relname.replaceAll('"', '""')}"`;
      const rows = await query(`SELECT to_jsonb(t)::text AS row FROM ${quoted} t ORDER BY 1 LIMIT 10001`);
      if (rows.length > 10000) invalid();
      const values: string[] = [];
      for (const entry of rows) {
        if (typeof entry.row !== 'string') invalid();
        const bytes = Buffer.from(entry.row);
        size += bytes.length;
        if (size > 64 * 1024 * 1024) invalid();
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length).update(bytes);
        values.push(entry.row);
      }
      raw.push({ name: relname, rows: values });
    }
    const runs = await query('SELECT id::text,trip_id::text,status FROM agent_runs ORDER BY id LIMIT 2');
    const trips = await query('SELECT id::text,owner_id::text FROM trips ORDER BY id LIMIT 2');
    const invocations = await query('SELECT id::text,run_id::text,reservation_id::text,provider,model,account_id FROM agent_invocations ORDER BY id LIMIT 2');
    const calls = await query(`SELECT run_id::text,invocation_id::text,call_id,usage FROM model_calls ORDER BY started_at,call_id LIMIT ${expectedCalls + 1}`);
    const reservations = await query('SELECT id::text,logical_run_id::text,charged_cost_micros::text,actual_cost_micros::text FROM quota_reservations ORDER BY id LIMIT 2');
    return { fingerprint: hash.digest('hex'), raw, runs, trips, invocations, calls, reservations };
  } catch { return invalid(); }
  finally { client?.release(true); }
}
