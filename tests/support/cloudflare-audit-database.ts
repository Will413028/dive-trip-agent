import { historyIdentity } from '../../evals/cloudflare-history-profile.ts';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';

export type CloudflareAuditQuery = (text: string, values?: string[]) => Promise<QueryResult>;
const timeoutMs = 2000;
const failure = () => new Error('CLOUDFLARE_AUDIT_DATABASE_FAILED');

async function connect(pool: Pool): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(failure()); }, timeoutMs);
    try {
      pool.connect().then(client => {
        clearTimeout(timer);
        if (expired) client.release(true);
        else resolve(client);
      }, () => { clearTimeout(timer); reject(failure()); });
    } catch { clearTimeout(timer); reject(failure()); }
  });
}

/** Fixed workbench audit boundary. No DB/schema/timeout overrides or pool ownership.
 * The callback receives only bounded queries on one read-only, repeatable snapshot.
 * Always destroy the client: this ends its transaction and cancels timed-out work.
 * Callers retain their own public error codes; no raw DB error escapes here. */
export async function withCloudflareAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, 'workbench_live', work);
}

export const CLOUDFLARE_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_RETAINED_SCHEMA_1'));
/** Separate fixed forensic scope, never a caller-selected schema override. */
export async function withCloudflareRetainedAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_SECOND_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_SECOND_RETAINED_SCHEMA_1'));
/** Second stopped campaign only; never accepts a caller-selected schema. */
export async function withCloudflareSecondRetainedAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_SECOND_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_QUALITY_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_QUALITY_RETAINED_SCHEMA_1'));
export async function withCloudflareQualityAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_QUALITY_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_REVISION_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_REVISION_RETAINED_SCHEMA_1'));
/** Fixed stopped revision scope; no caller-selected schema or write capability. */
export async function withCloudflareRevisionAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_REVISION_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_RECOVERY_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_RECOVERY_RETAINED_SCHEMA_1'));
/** Fixed stopped recovery scope; no caller-selected schema or write capability. */
export async function withCloudflareRecoveryAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_RECOVERY_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_GROUNDED_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_GROUNDED_RETAINED_SCHEMA_1'));
/** Fixed stopped grounded scope; no caller-selected schema or write capability. */
export async function withCloudflareGroundedAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_GROUNDED_RETAINED_SCHEMA(), work);
}

export const CLOUDFLARE_NONTHINKING_RETAINED_SCHEMA = () => (historyIdentity('audit_database_CLOUDFLARE_NONTHINKING_RETAINED_SCHEMA_1'));
/** Fixed stopped nonthinking scope; no caller-selected schema or write capability. */
export async function withCloudflareNonthinkingAuditDatabase<T>(pool: Pool,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  return withAuditDatabase(pool, CLOUDFLARE_NONTHINKING_RETAINED_SCHEMA(), work);
}

/** Explicit synthetic local connection fields; never environment/passfile fallback. */
export function assertCloudflareAuditPools(pools: Pool[]): void {
  if (!pools.length || new Set(pools).size !== pools.length) throw failure();
  for (const pool of pools) {
    assertCloudflareAuditPool(pool);
    if (pool.options.port !== pools[0].options.port) throw failure();
  }
}

/** Single-source admission; does not impose cross-pool identity or port policy. */
export function assertCloudflareAuditPool(pool: Pool): void {
  if (pool.options.connectionString !== undefined || pool.options.host !== '127.0.0.1'
    || pool.options.database !== 'dive_trip_test' || pool.options.user !== 'postgres' || pool.options.ssl !== false
    || !Number.isInteger(pool.options.port) || Number(pool.options.port) < 1 || Number(pool.options.port) > 65535
    || pool.options.password !== 'offline-placeholder-not-a-credential'
    || !(Number(pool.options.connectionTimeoutMillis) > 0 && Number(pool.options.connectionTimeoutMillis) <= 5000)
    || !(Number(pool.options.statement_timeout) > 0 && Number(pool.options.statement_timeout) <= 10000)) throw failure();
}

async function withAuditDatabase<T>(pool: Pool, schema: string,
  work: (query: CloudflareAuditQuery) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await connect(pool);
    const selected = client;
    const query: CloudflareAuditQuery = (text, values) => {
      // pg supports this per-query timeout; @types/pg declares only the client option.
      const config: QueryConfig<string[]> & { query_timeout: number } = { text, values, query_timeout: timeoutMs };
      return selected.query(config);
    };
    await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL statement_timeout = '2000ms'");
    const scope = await query('SELECT current_database() AS database, current_schema() AS schema');
    if (scope.rows.length !== 1 || scope.rows[0].database !== 'dive_trip_test' || scope.rows[0].schema !== schema) {
      throw failure();
    }
    return await work(query);
  } catch { throw failure(); }
  finally { client?.release(true); }
}
