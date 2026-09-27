import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '../domain/errors.ts';
import { database, transaction } from './db.ts';

/** Explicit server policy; this module neither reads configuration nor verifies provider prices. */
export type QuotaPolicy = { enabled: false } | {
  enabled: true;
  dailyBudgetMicros: number;
  priceBasis: 'synthetic' | 'server-verified';
  reservationTtlMs: number;
};
export const DISABLED_QUOTA_POLICY: QuotaPolicy = Object.freeze({ enabled: false });
export const QUOTA_LIMITS = Object.freeze({ concurrent: 3, ipMinute: 5, ipDay: 100, sessionDay: 20 });
export type ReserveRunInput = {
  ownerId: string; ipKey: string; requestId: string; payloadHash: string;
  previousIpKey?: string;
  logicalRunId?: string;
  maxCostMicros: number; now: Date;
};
export type QuotaReservation = {
  reservationId: string; ownerId: string; day: string;
  status: 'reserved' | 'expired' | 'settled';
  maxCostMicros: number; chargedCostMicros: number; actualCostMicros: number | null;
  expiresAt: Date;
};
/** Only created=true authorizes a new execution. A receipt replay never does. */
export type ReserveRunResult = QuotaReservation & { created: boolean };
/** Trusted server usage callback, not an HTTP authorization interface. May settle after owner expiry. */
export type SettleRunInput = { reservationId: string; actualCostMicros: number | null; now: Date };
/** Caller owns BEGIN/COMMIT and must run registered checks both immediately
 * before COMMIT and after COMMIT resolves, before authorizing any execution. */
export type QuotaTransaction = { client: PoolClient; afterCommit(check: () => void): void;
  /** performance.now() captured at the outer admission entry, before pool/lock waits. */
  startedAt?: number };

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reserveSchema = z.strictObject({
  ownerId: z.uuid(), ipKey: digest, previousIpKey: digest.optional(), payloadHash: digest,
  logicalRunId: z.uuid().optional(),
  requestId: z.string().min(1).max(128).refine(s => s.trim().length > 0 && !s.includes('\0')),
  maxCostMicros: integer, now: z.date(),
});
const policySchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), dailyBudgetMicros: integer.positive(),
    priceBasis: z.enum(['synthetic', 'server-verified']), reservationTtlMs: z.number().int().positive().max(300_000) }),
]);
const settleSchema = z.strictObject({ reservationId: z.uuid(), actualCostMicros: integer.nullable(), now: z.date() });
type Row = {
  id: string; owner_id: string; ip_key: string; request_id: string; payload_hash: string;
  day: string; status: QuotaReservation['status']; expires_at: Date; reserved_at: Date;
  max_cost_micros: string; charged_cost_micros: string; actual_cost_micros: string | null;
  logical_run_id: string | null;
};
const columns = '*, day::text AS day';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
function fail(code: string): never { throw new DomainError(code); }
function view(row: Row): QuotaReservation {
  return { reservationId: row.id, ownerId: row.owner_id, day: row.day, status: row.status,
    maxCostMicros: Number(row.max_cost_micros), chargedCostMicros: Number(row.charged_cost_micros),
    actualCostMicros: row.actual_cost_micros === null ? null : Number(row.actual_cost_micros), expiresAt: row.expires_at };
}
export async function lockQuotaGlobal(client: PoolClient) {
  // The permanent global gate precedes day rows: separate midnight buckets must
  // still serialize against one shared concurrency limit and cross-day receipts.
  const locked = await client.query('SELECT id FROM quota_global_lock WHERE id=1 FOR UPDATE');
  if (!locked.rowCount) fail('QUOTA_UNAVAILABLE');
}
const globalLock = lockQuotaGlobal;
async function bucketLocks(client: PoolClient, day: string, ipKey: string, ownerId: string) {
  // All writers: global gate -> global day -> IP -> session day -> reservation.
  await client.query('INSERT INTO quota_days(day) VALUES ($1) ON CONFLICT DO NOTHING', [day]);
  await client.query('SELECT day FROM quota_days WHERE day=$1 FOR UPDATE', [day]);
  await client.query('INSERT INTO quota_ips(ip_key) VALUES ($1) ON CONFLICT DO NOTHING', [ipKey]);
  await client.query('SELECT ip_key FROM quota_ips WHERE ip_key=$1 FOR UPDATE', [ipKey]);
  await client.query('INSERT INTO quota_session_days(owner_id,day) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId, day]);
  await client.query('SELECT owner_id FROM quota_session_days WHERE owner_id=$1 AND day=$2 FOR UPDATE', [ownerId, day]);
}

/** Acquire quota locks before a caller locks an invocation or reads its usage. */
export async function lockQuotaReservation(client: PoolClient, reservationId: string): Promise<void> {
  await globalLock(client);
  const row = (await client.query<Row>(`SELECT ${columns} FROM quota_reservations WHERE id=$1`, [reservationId])).rows[0];
  if (!row) fail('NOT_FOUND');
  await bucketLocks(client, row.day, row.ip_key, row.owner_id);
  await client.query('SELECT id FROM quota_reservations WHERE id=$1 FOR UPDATE', [reservationId]);
}

/** now, digest keys, cost bounds and priceBasis must come from trusted server code.
 * During the first 60 seconds of a Taipei day the server supplies previousIpKey
 * for the same verified peer with yesterday's salt. It is used only for rolling
 * minute reads, never persisted or used for day quotas/receipt identity.
 * Raw IPs are never stored; this module does not derive or authenticate keys.
 * now anchors an injected clock; monotonic elapsed time consumes the lease even
 * while waiting for a pool connection/lock/commit. A day change requires a fresh
 * call (and fresh salt keys). Capture a new now for each call, including settle.
 */
export async function reserveRun(raw: ReserveRunInput, policy: QuotaPolicy = DISABLED_QUOTA_POLICY,
  external?: QuotaTransaction): Promise<ReserveRunResult> {
  const startedAt = external?.startedAt ?? performance.now();
  const parsed = reserveSchema.safeParse(raw);
  const configured = policySchema.safeParse(policy);
  if (!parsed.success || !configured.success) fail('INVALID_QUOTA_INPUT');
  const input = parsed.data;
  const effectiveNow = () => new Date(input.now.getTime() + Math.ceil(performance.now() - startedAt));
  const inputDay = dayFormatter.format(input.now);
  const assertAdmission = (expiresAt: Date) => {
    const now = effectiveNow();
    if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime())) fail('INVALID_QUOTA_INPUT');
    if (now >= expiresAt) fail('QUOTA_RESERVATION_EXPIRED');
    if (dayFormatter.format(now) !== inputDay) fail('QUOTA_CLOCK_CHANGED');
    return now;
  };
  const operation = async (client: PoolClient) => {
    await globalLock(client);
    const previous = (await client.query<Row>(`SELECT ${columns} FROM quota_reservations WHERE owner_id=$1 AND request_id=$2`,
      [input.ownerId, input.requestId])).rows[0];
    const day = previous?.day ?? inputDay;
    const expiresAt = configured.data.enabled
      ? new Date(input.now.getTime() + configured.data.reservationTtlMs) : undefined;
    if (!previous && expiresAt) assertAdmission(expiresAt);
    await bucketLocks(client, day, previous?.ip_key ?? input.ipKey, input.ownerId);
    // Recheck real TTL after lock waits as well as the explicitly supplied clock.
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [input.ownerId]);
    const session = await client.query(`SELECT id FROM sessions WHERE id=$1
      AND expires_at>$2 AND expires_at>clock_timestamp()`, [input.ownerId, effectiveNow()]);
    if (!session.rowCount) fail('NOT_FOUND');
    if (previous) {
      const row = (await client.query<Row>(`SELECT ${columns} FROM quota_reservations WHERE id=$1 FOR UPDATE`, [previous.id])).rows[0];
      if (row.payload_hash !== input.payloadHash || BigInt(row.max_cost_micros) !== BigInt(input.maxCostMicros)) fail('IDEMPOTENCY_CONFLICT');
      if (row.logical_run_id !== (input.logicalRunId ?? null)) fail('IDEMPOTENCY_CONFLICT');
      if (row.status === 'reserved' && row.expires_at <= effectiveNow()) {
        await client.query("UPDATE quota_reservations SET status='expired' WHERE id=$1", [row.id]);
        row.status = 'expired';
      }
      return { ...view(row), created: false };
    }
    if (!configured.data.enabled) fail('LIVE_DISABLED');
    const activePolicy = configured.data;
    const checkedAt = assertAdmission(expiresAt!);
    // The global gate serializes all writers, including the previous day's IP
    // bucket; no second IP lock is needed. ANY counts each receipt only once.
    const minuteKeys = input.previousIpKey === undefined ? [input.ipKey] : [input.ipKey, input.previousIpKey];
    // Capacity ignores expired leases without mutating other buckets' receipts.
    // Their status is lazily materialized on replay; charges/counts never expire.
    const usage = (await client.query<{ active: string; charged: string; ip_minute: string; ip_day: string; session_day: string; logical_seen: boolean }>(`
      SELECT count(*) FILTER (WHERE status='reserved' AND expires_at>$4) AS active,
        (COALESCE(sum(charged_cost_micros) FILTER (WHERE day=$1),0)
          + COALESCE((SELECT charged_cost_micros FROM quota_daily_totals WHERE day=$1),0))::text AS charged,
        count(*) FILTER (WHERE ip_key=ANY($5::text[]) AND reserved_at>$4::timestamptz-interval '1 minute') AS ip_minute,
        count(*) FILTER (WHERE ip_key=$2 AND day=$1) AS ip_day,
        count(DISTINCT COALESCE(logical_run_id,id)) FILTER (WHERE owner_id=$3 AND day=$1) AS session_day,
        COALESCE(bool_or(logical_run_id=$6::uuid AND owner_id=$3 AND day=$1),false) AS logical_seen
      FROM quota_reservations`, [day, input.ipKey, input.ownerId, checkedAt, minuteKeys, input.logicalRunId ?? null])).rows[0];
    // Zero-cost work still reserves invocation capacity after historical spend
    // exhausts the budget; every non-cost admission guard remains in force.
    if (input.maxCostMicros > 0 && BigInt(usage.charged) + BigInt(input.maxCostMicros) > BigInt(activePolicy.dailyBudgetMicros)) fail('QUOTA_BUDGET');
    if (Number(usage.active) >= QUOTA_LIMITS.concurrent) fail('QUOTA_CONCURRENCY');
    if (Number(usage.ip_minute) >= QUOTA_LIMITS.ipMinute) fail('QUOTA_IP_MINUTE');
    if (Number(usage.ip_day) >= QUOTA_LIMITS.ipDay) fail('QUOTA_IP_DAY');
    if (Number(usage.session_day) >= QUOTA_LIMITS.sessionDay && !usage.logical_seen) fail('QUOTA_SESSION_DAY');
    const admittedAt = assertAdmission(expiresAt!);
    const row = (await client.query<Row>(`INSERT INTO quota_reservations
      (id,owner_id,ip_key,request_id,payload_hash,day,reserved_at,expires_at,max_cost_micros,charged_cost_micros,status,logical_run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'reserved',$10) RETURNING ${columns}`,
    [randomUUID(), input.ownerId, input.ipKey, input.requestId, input.payloadHash, day, admittedAt, expiresAt, input.maxCostMicros, input.logicalRunId ?? null])).rows[0];
    assertAdmission(row.expires_at);
    return { ...view(row), created: true };
  };
  const result = external ? await operation(external.client) : await transaction(database(), operation);
  // A delayed COMMIT response must not authorize an already expired execution.
  // If this fails after commit, keep the charge/receipt conservatively; replay
  // remains created=false. No provider call is authorized by that failed call.
  if (result.created) {
    if (external) external.afterCommit(() => assertAdmission(result.expiresAt));
    else assertAdmission(result.expiresAt);
  }
  return result;
}

/** Immutable settlement: exact replay is a no-op; conflicting usage is rejected.
 * null retains the bound. Known late usage may settle an expired reservation.
 * Over-bound actual usage is recorded honestly and blocks later reservations;
 * this ledger cannot prevent a provider from exceeding its caller's estimate.
 */
export async function settleRun(raw: SettleRunInput, externalClient?: PoolClient): Promise<QuotaReservation> {
  const parsed = settleSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_QUOTA_INPUT');
  const input = parsed.data;
  const operation = async (client: PoolClient) => {
    await globalLock(client);
    const identity = (await client.query<Row>(`SELECT ${columns} FROM quota_reservations WHERE id=$1`, [input.reservationId])).rows[0];
    if (!identity) fail('NOT_FOUND');
    await bucketLocks(client, identity.day, identity.ip_key, identity.owner_id);
    const row = (await client.query<Row>(`SELECT ${columns} FROM quota_reservations WHERE id=$1 FOR UPDATE`, [identity.id])).rows[0];
    if (input.now < row.reserved_at) fail('INVALID_QUOTA_INPUT');
    if (row.status === 'settled') {
      if ((row.actual_cost_micros === null ? null : Number(row.actual_cost_micros)) !== input.actualCostMicros) fail('IDEMPOTENCY_CONFLICT');
      return view(row);
    }
    const saved = (await client.query<Row>(`UPDATE quota_reservations SET status='settled', settled_at=$2,
      actual_cost_micros=$3, charged_cost_micros=COALESCE($3::bigint,max_cost_micros)
      WHERE id=$1 RETURNING ${columns}`, [identity.id, input.now, input.actualCostMicros])).rows[0];
    return view(saved);
  };
  return externalClient ? operation(externalClient) : transaction(database(), operation);
}
