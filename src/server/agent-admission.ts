import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '../domain/errors';
import { database, transaction } from './db';
import { lockQuotaGlobal, lockQuotaReservation, reserveRun, settleRun, type QuotaPolicy, type QuotaReservation } from './quota';
import { claimResume, startRun, withRunScope, type AgentRun } from './run-store';
import { GEMINI_MODEL } from '../agent/model-id';
import { freeModelSchema } from '../agent/openrouter-wire';
import type { AgentProviderKind, ProviderAccountingEvidence } from '../agent/provider-contract';
import { PROVIDER_KINDS, providerAccountingEvidenceSchema } from '../agent/provider-contract';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS, cloudflareAccountSchema, matchesCloudflareModel } from '../agent/cloudflare-wire';
import { referenceProviderCost } from './model-cost';

export const ADMISSION_PROVIDER = 'gemini' as const;
export const ADMISSION_MODEL = GEMINI_MODEL;
export type Admission = { id: string; reservationId: string; priorModelCalls: number; expiresAt: Date;
  provider: AgentProviderKind; model: string; accountId?: string };
export type AdmissionResult = { run: AgentRun; executed: boolean; admission: Admission };
type CommonInput = { ownerId: string; tripId: string; ipKey: string; previousIpKey?: string;
  maxCostMicros: number; now: Date; policy: QuotaPolicy; provider?: AgentProviderKind; model?: string; accountId?: string };
export type AdmitStartInput = CommonInput & { requestId: string; message: string; baseVersion: number };
export type AdmitResumeInput = CommonInput & { runId: string; interruptId: string; confirmed: boolean };
export type ModelUsage = { promptTokens: number; outputTokens: number; totalTokens: number;
  cachedTokens?: number; thoughtTokens?: number };
export type ModelCallEvent = { kind: 'model-call-start'; callId: string } |
  { kind: 'model-call-usage'; callId: string; usage: ModelUsage | null; providerEvidence?: ProviderAccountingEvidence };
export type AdmissionUsage = { runId: string; reservationId: string; provider: AgentProviderKind;
  model: string; calls: { callId: string; status: 'started' | 'completed'; usage: ModelUsage | null;
    providerEvidence?: ProviderAccountingEvidence }[];
  complete: boolean; hasUnknownUsage: boolean };

const id = z.string().min(1).max(128).refine(s => s.trim().length > 0 && !s.includes('\0'));
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.strictObject({ promptTokens: tokens, outputTokens: tokens, totalTokens: tokens,
  cachedTokens: tokens.optional(), thoughtTokens: tokens.optional() }).refine(u =>
  u.promptTokens <= u.totalTokens && u.outputTokens <= u.totalTokens &&
  BigInt(u.promptTokens) + BigInt(u.outputTokens) + BigInt(u.thoughtTokens ?? 0) <= BigInt(u.totalTokens) &&
  (u.cachedTokens ?? 0) <= u.promptTokens && (u.thoughtTokens ?? 0) <= u.totalTokens);
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model-call-start'), callId: id }),
  z.strictObject({ kind: z.literal('model-call-usage'), callId: id, usage: usageSchema.nullable(),
    providerEvidence: providerAccountingEvidenceSchema.optional() }),
]);
const common = { ownerId: z.uuid(), tripId: z.uuid(), ipKey: z.string(), previousIpKey: z.string().optional(),
  maxCostMicros: tokens.positive(), now: z.date(), policy: z.custom<QuotaPolicy>(), provider: z.enum(PROVIDER_KINDS).optional(), model: id.optional(),
  accountId: z.string().optional() };
const startSchema = z.strictObject({ ...common, requestId: id,
  message: z.string().min(1).max(4000).refine(s => s.trim().length > 0 && !s.includes('\0')),
  baseVersion: z.number().int().positive().max(2147483647) });
const resumeSchema = z.strictObject({ ...common, maxCostMicros: z.literal(0), runId: z.uuid(), interruptId: id, confirmed: z.boolean() });
type InvocationRow = { id: string; run_id: string; reservation_id: string; provider: AgentProviderKind; model: string; account_id: string | null; kind: 'start' | 'resume';
  max_cost_micros: string; status: 'active' | 'expired' | 'settled'; prior_model_calls: number; expires_at: Date };
type CallRow = { invocation_id: string; call_id: string; status: 'started' | 'completed'; usage: ModelUsage | null;
  provider_evidence: ProviderAccountingEvidence | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code: string): never { throw new DomainError(code); }
const admissionView = (row: InvocationRow): Admission => ({ id: row.id, reservationId: row.reservation_id,
  priorModelCalls: row.prior_model_calls, expiresAt: row.expires_at, provider: row.provider, model: row.model,
  ...(row.provider === 'cloudflare' && row.account_id !== null ? { accountId: row.account_id } : {}) });

function validateBinding(provider: AgentProviderKind, model: string, accountId: string | null): void {
  if (provider === 'gemini' && model !== GEMINI_MODEL) fail('PROVIDER_CONFLICT');
  if (provider === 'openrouter' && !freeModelSchema.safeParse(model).success) fail('PROVIDER_CONFLICT');
  if (provider === 'cloudflare' && (model !== CLOUDFLARE_MODEL || !cloudflareAccountSchema.safeParse(accountId).success)) fail('PROVIDER_CONFLICT');
  if (provider !== 'cloudflare' && accountId !== null) fail('PROVIDER_CONFLICT');
}

async function lookupRun(client: PoolClient, owner: string, trip: string, selector: { runId: string } | { requestId: string }) {
  return (await client.query<{ id: string; provider: 'fixture' | AgentProviderKind }>(`
    SELECT r.id, COALESCE((SELECT i.provider FROM agent_invocations i WHERE i.run_id=r.id LIMIT 1), 'fixture') AS provider
    FROM agent_runs r JOIN trips t ON t.id=r.trip_id JOIN sessions s ON s.id=t.owner_id
    WHERE t.owner_id=$1 AND t.id=$2 AND ${'runId' in selector ? 'r.id=$3::uuid' : 'r.request_id=$3'}
      AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`,
  [owner, trip, 'runId' in selector ? selector.runId : selector.requestId])).rows[0];
}

export async function getRunProvider(owner: string, trip: string,
  selector: { runId: string } | { requestId: string }): Promise<'fixture' | AgentProviderKind | null> {
  const valid = z.union([z.strictObject({ runId: z.uuid() }), z.strictObject({ requestId: id })]).safeParse(selector);
  if (!z.uuid().safeParse(owner).success || !z.uuid().safeParse(trip).success || !valid.success) return null;
  const client = await database().connect();
  try { return (await lookupRun(client, owner, trip, valid.data))?.provider ?? null; }
  finally { client.release(); }
}

export function admitStart(input: AdmitStartInput): Promise<AdmissionResult> { return admit('start', input); }
export function admitResume(input: AdmitResumeInput): Promise<AdmissionResult> { return admit('resume', input); }

async function admit(kind: 'start' | 'resume', raw: AdmitStartInput | AdmitResumeInput): Promise<AdmissionResult> {
  const startedAt = performance.now();
  const parsed = (kind === 'start' ? startSchema : resumeSchema).safeParse(raw);
  if (!parsed.success) fail('INVALID_ADMISSION');
  const input = parsed.data;
  const provider = input.provider ?? ADMISSION_PROVIDER;
  const model = input.model ?? ADMISSION_MODEL;
  const accountId = input.accountId ?? null;
  validateBinding(provider, model, accountId);
  const checks: (() => void)[] = [];
  const result = await transaction(database(), async client => {
    // Never acquire trip/run locks before quota locks in this transaction.
    await lockQuotaGlobal(client);
    const existing = await lookupRun(client, input.ownerId, input.tripId,
      'runId' in input ? { runId: input.runId } : { requestId: input.requestId });
    if ('runId' in input && !existing) fail('NOT_FOUND');
    if (existing?.provider === 'fixture') fail('PROVIDER_CONFLICT');
    if (existing && (await client.query(`SELECT id FROM agent_invocations WHERE run_id=$1
      AND (provider<>$2 OR model<>$3 OR account_id IS DISTINCT FROM $4::text)`,
      [existing.id, provider, model, accountId])).rowCount) fail('PROVIDER_CONFLICT');
    const logicalRunId = existing?.id ?? randomUUID();
    const key = 'runId' in input ? ['resume', logicalRunId, input.interruptId] : ['start', input.tripId, input.requestId];
    const payload = 'runId' in input ? [...key, input.confirmed] : [...key, input.message, input.baseVersion];
    const reserved = await reserveRun({ ownerId: input.ownerId, ipKey: input.ipKey, previousIpKey: input.previousIpKey,
      requestId: `agent:${digest(key)}`, payloadHash: digest(provider === 'cloudflare'
        ? [provider, model, accountId, ...payload] : [provider, model, ...payload]),
      logicalRunId, maxCostMicros: input.maxCostMicros, now: input.now }, input.policy,
    { client, startedAt, afterCommit: check => checks.push(check) });
    const claimed = 'runId' in input
      ? await claimResume(input.ownerId, input.tripId, logicalRunId, input.interruptId, input.confirmed, client)
        .then(value => ({ run: value.run, executed: value.claimed }))
      : await startRun(input.ownerId, input.tripId, input.requestId, input.message, input.baseVersion, client, logicalRunId)
        .then(value => ({ run: value.run, executed: value.created }));
    if (claimed.executed !== reserved.created) fail('ADMISSION_STATE_CONFLICT');
    let row: InvocationRow;
    if (!claimed.executed) {
      row = (await client.query<InvocationRow>('SELECT * FROM agent_invocations WHERE reservation_id=$1', [reserved.reservationId])).rows[0];
      if (!row || row.run_id !== claimed.run.id || row.kind !== kind) fail('ADMISSION_STATE_CONFLICT');
    } else {
      // Expired predecessors retain unknown quota charges. Late callbacks are
      // fenced; this does not pretend an interrupted provider call cost zero.
      await client.query("UPDATE agent_invocations SET status='expired' WHERE run_id=$1 AND status='active' AND expires_at<=clock_timestamp()", [logicalRunId]);
      if ((await client.query("SELECT id FROM agent_invocations WHERE run_id=$1 AND status='active'", [logicalRunId])).rowCount) fail('ADMISSION_ACTIVE');
      const prior = (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_calls WHERE run_id=$1', [logicalRunId])).rows[0].count;
      if (kind === 'start' ? prior >= 7 : prior > 7) fail('MODEL_CALL_LIMIT');
      row = (await client.query<InvocationRow>(`INSERT INTO agent_invocations
        (id,run_id,reservation_id,kind,provider,model,account_id,max_cost_micros,status,prior_model_calls,expires_at)
        SELECT $1,r.id,$3,$4,$8,$9,$10,$5,'active',$6,LEAST($7::timestamptz,r.lease_expires_at)
        FROM agent_runs r WHERE r.id=$2 AND r.status='running' AND r.lease_expires_at>clock_timestamp()
        RETURNING *`, [randomUUID(), logicalRunId, reserved.reservationId, kind, input.maxCostMicros, prior, reserved.expiresAt, provider, model, accountId])).rows[0];
      if (!row) fail('RUN_NOT_RUNNING');
      const expiresAt = row.expires_at;
      checks.push(() => { if (expiresAt.getTime() <= Date.now()) fail('QUOTA_RESERVATION_EXPIRED'); });
    }
    for (const check of checks) check();
    return { run: claimed.run, executed: claimed.executed, admission: admissionView(row) };
  });
  for (const check of checks) check();
  return result;
}

async function invocation(client: PoolClient, trip: string, admissionId: string): Promise<InvocationRow> {
  const row = (await client.query<InvocationRow>(`SELECT i.* FROM agent_invocations i JOIN agent_runs r ON r.id=i.run_id
    WHERE i.id=$1 AND r.trip_id=$2 FOR UPDATE OF i`, [admissionId, trip])).rows[0];
  if (!row) fail('NOT_FOUND');
  validateBinding(row.provider, row.model, row.account_id);
  return row;
}
async function requireActive(client: PoolClient, admissionId: string) {
  const live = await client.query(`SELECT i.id FROM agent_invocations i JOIN agent_runs r ON r.id=i.run_id
    JOIN quota_reservations q ON q.id=i.reservation_id
    JOIN trips t ON t.id=r.trip_id JOIN sessions s ON s.id=t.owner_id
    WHERE i.id=$1 AND i.status='active' AND i.expires_at>clock_timestamp()
      AND q.status='reserved' AND q.expires_at>clock_timestamp()
      AND q.owner_id=t.owner_id AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
      AND r.status='running' AND r.lease_expires_at>clock_timestamp()`, [admissionId]);
  if (!live.rowCount) fail('ADMISSION_NOT_ACTIVE');
}

/** Durable private hook. Only recorded=true for start authorizes a provider call;
 * duplicate call IDs never authorize a retry, even if usage was never received. */
export async function accountModelCall(owner: string, trip: string, admissionId: string,
  raw: ModelCallEvent): Promise<{ recorded: boolean }> {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_MODEL_USAGE');
  if (!z.uuid().safeParse(admissionId).success) fail('NOT_FOUND');
  const event = parsed.data;
  return withRunScope(owner, trip, async client => {
    const row = await invocation(client, trip, admissionId);
    await requireActive(client, admissionId);
    // New confirmations finish with a native receipt, never model generation.
    // The stored bound distinguishes them from historical positive-cost continuations.
    if (BigInt(row.max_cost_micros) === 0n) fail('MODEL_GENERATION_DISABLED');
    const previous = (await client.query<CallRow>('SELECT * FROM model_calls WHERE run_id=$1 AND call_id=$2', [row.run_id, event.callId])).rows[0];
    if (previous && previous.invocation_id !== admissionId) fail('IDEMPOTENCY_CONFLICT');
    if (event.kind === 'model-call-start') {
      if (previous) return { recorded: false };
      const count = (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM model_calls WHERE run_id=$1', [row.run_id])).rows[0].count;
      if (count >= 7) fail('MODEL_CALL_LIMIT');
      await client.query("INSERT INTO model_calls(invocation_id,run_id,call_id,status) VALUES ($1,$2,$3,'started')", [admissionId, row.run_id, event.callId]);
    } else {
      if (!previous) fail('MODEL_CALL_NOT_STARTED');
      if (row.provider === 'gemini' && event.providerEvidence) fail('INVALID_MODEL_USAGE');
      if (row.provider === 'openrouter') {
        const evidence = event.providerEvidence;
        if (evidence && (evidence.provider !== 'openrouter'
          || !evidence.generationId || !evidence.returnedModel
          || ![row.model, row.model.slice(0, -5)].includes(evidence.returnedModel)
          || (evidence.reportedCostMicros !== null && evidence.reportedCostMicros !== 0))) fail('INVALID_MODEL_USAGE');
        if (event.usage && (!evidence || evidence.reportedCostMicros !== 0)) fail('INVALID_MODEL_USAGE');
      }
      if (row.provider === 'cloudflare') {
        const evidence = event.providerEvidence;
        if (evidence && evidence.provider !== 'cloudflare') fail('INVALID_MODEL_USAGE');
        if (event.usage && (!evidence || evidence.provider !== 'cloudflare'
          || evidence.priceBasis !== CLOUDFLARE_PRICE_BASIS || !matchesCloudflareModel(evidence.returnedModel)
          || event.usage.totalTokens !== event.usage.promptTokens + event.usage.outputTokens
          || event.usage.thoughtTokens !== undefined)) fail('INVALID_MODEL_USAGE');
      }
      if (previous.status === 'completed') {
        if (!isDeepStrictEqual(previous.usage, event.usage)
          || !isDeepStrictEqual(previous.provider_evidence, event.providerEvidence ?? null)) fail('IDEMPOTENCY_CONFLICT');
        return { recorded: false };
      }
      await client.query("UPDATE model_calls SET status='completed',usage=$3::jsonb,provider_evidence=$4::jsonb,completed_at=clock_timestamp() WHERE invocation_id=$1 AND call_id=$2",
        [admissionId, event.callId, event.usage === null ? null : JSON.stringify(event.usage),
          event.providerEvidence ? JSON.stringify(event.providerEvidence) : null]);
    }
    await requireActive(client, admissionId);
    return { recorded: true };
  });
}

async function usageView(client: PoolClient, row: InvocationRow): Promise<AdmissionUsage> {
  const calls = (await client.query<CallRow>('SELECT * FROM model_calls WHERE invocation_id=$1 ORDER BY started_at,call_id', [row.id])).rows;
  const normalized = calls.map(call => ({ callId: call.call_id, status: call.status, usage: call.usage,
    ...(call.provider_evidence ? { providerEvidence: call.provider_evidence } : {}) }));
  const evidenceUnknown = (row.provider === 'openrouter' && normalized.some(call => call.status !== 'completed'
    || !call.providerEvidence || call.providerEvidence.provider !== 'openrouter'
    || call.providerEvidence.reportedCostMicros === null))
    || (row.provider === 'cloudflare' && normalized.some(call => call.status !== 'completed'
      || call.providerEvidence?.provider !== 'cloudflare'
      || call.providerEvidence.priceBasis !== CLOUDFLARE_PRICE_BASIS
      || !matchesCloudflareModel(call.providerEvidence.returnedModel)));
  return { runId: row.run_id, reservationId: row.reservation_id, provider: row.provider, model: row.model,
    calls: normalized,
    complete: calls.every(call => call.status === 'completed'),
    hasUnknownUsage: calls.some(call => call.status !== 'completed' || call.usage === null) || evidenceUnknown };
}

export async function getAdmissionUsage(owner: string, trip: string, admissionId: string): Promise<AdmissionUsage> {
  if (!z.uuid().safeParse(admissionId).success) fail('NOT_FOUND');
  return withRunScope(owner, trip, async client => usageView(client, await invocation(client, trip, admissionId)));
}

/** Server-only settlement, allowed after lease/owner expiry. Missing usage forces
 * unknown cost regardless of the caller's estimate. Never infer zero from null. */
export async function settleAdmission(admissionId: string, actualCostMicros: number | null): Promise<QuotaReservation> {
  return settle(admissionId, actualCostMicros);
}

/** Trusted runtime caller only, AFTER worker exit and accounting hooks drain.
 * Never reconciles old receipts. Recompute from locked durable evidence, not an
 * error payload or a caller-supplied token/cost estimate. */
export async function settleRejectedToolArguments(expected: Admission, signal?: AbortSignal): Promise<QuotaReservation> {
  return settle(expected.id, null, expected, signal);
}

async function settle(admissionId: string, actualCostMicros: number | null, expected?: Admission, signal?: AbortSignal): Promise<QuotaReservation> {
  if (!z.uuid().safeParse(admissionId).success || !tokens.nullable().safeParse(actualCostMicros).success) fail('INVALID_ADMISSION');
  return transaction(database(), async client => {
    await lockQuotaGlobal(client);
    const identity = (await client.query<InvocationRow>('SELECT * FROM agent_invocations WHERE id=$1', [admissionId])).rows[0];
    if (!identity) fail('NOT_FOUND');
    await lockQuotaReservation(client, identity.reservation_id);
    // Freeze callbacks after quota locks, before reading usage. Callbacks never
    // acquire quota locks, so their trip -> invocation ordering cannot cycle.
    const row = (await client.query<InvocationRow>('SELECT * FROM agent_invocations WHERE id=$1 FOR UPDATE', [admissionId])).rows[0];
    const usage = await usageView(client, row);
    const knownBinding = (row.provider === 'gemini' && row.model === GEMINI_MODEL && row.account_id === null)
      || (row.provider === 'openrouter' && freeModelSchema.safeParse(row.model).success && row.account_id === null)
      || (row.provider === 'cloudflare' && row.model === CLOUDFLARE_MODEL && cloudflareAccountSchema.safeParse(row.account_id).success);
    let actual = !knownBinding || usage.hasUnknownUsage ? null : actualCostMicros;
    if (expected) {
      // This new policy applies only to an active invocation, never a historical
      // settled/expired receipt, even if all its token records look complete.
      if (row.status !== 'active') fail('ADMISSION_NOT_ACTIVE');
      const bound = expected.reservationId === row.reservation_id && expected.provider === row.provider
        && expected.model === row.model && (expected.accountId ?? null) === row.account_id;
      const integrity = await client.query(`SELECT q.id FROM quota_reservations q
        JOIN agent_runs r ON r.id=$2 JOIN trips t ON t.id=r.trip_id
        WHERE q.id=$1 AND q.status='reserved' AND q.logical_run_id=r.id AND q.owner_id=t.owner_id
          AND q.expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM model_calls c WHERE c.invocation_id=$3 AND c.run_id IS DISTINCT FROM r.id)`,
      [row.reservation_id, row.run_id, row.id]);
      actual = !signal?.aborted && row.expires_at.getTime() > Date.now() && bound && knownBinding && integrity.rowCount === 1 && usage.complete
        && !usage.hasUnknownUsage && usage.calls.length > 0 ? 0 : null;
      for (const call of usage.calls) {
        // Revalidate only the persisted evidence fields, without trusting row types.
        const evidenceValid = eventSchema.safeParse({ kind: 'model-call-usage', callId: call.callId,
          usage: call.usage, ...(call.providerEvidence ? { providerEvidence: call.providerEvidence } : {}) }).success;
        const modelMatches = row.provider === 'gemini' ? call.providerEvidence === undefined
          : row.provider === 'cloudflare' ? call.providerEvidence?.provider === 'cloudflare'
          : call.providerEvidence?.provider === 'openrouter'
            && [row.model, row.model.slice(0, -5)].includes(call.providerEvidence.returnedModel ?? '');
        const cost = evidenceValid && modelMatches ? referenceProviderCost(row.provider, call.usage, call.providerEvidence) : null;
        actual = actual === null || cost === null || !Number.isSafeInteger(actual + cost) ? null : actual + cost;
      }
    }
    const settled = await settleRun({ reservationId: row.reservation_id, actualCostMicros: actual, now: new Date() }, client);
    await client.query("UPDATE agent_invocations SET status='settled' WHERE id=$1", [admissionId]);
    // Cancellation while the writes were in flight must roll back, not publish
    // a known receipt. Once COMMIT is dispatched it is the settlement boundary.
    if (expected && actual !== null && (signal?.aborted || row.expires_at.getTime() <= Date.now())) fail('ADMISSION_SETTLEMENT_ABORTED');
    return settled;
  });
}
