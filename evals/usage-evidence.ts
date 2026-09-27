import type { Pool } from 'pg';
import { z } from 'zod';
import { GEMINI_MODEL } from '../src/agent/model-id.ts';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS, cloudflareAccountSchema } from '../src/agent/cloudflare-wire.ts';
import { referenceModelCost, referenceProviderCost } from '../src/server/model-cost.ts';

const cloudflareBindingSchema = z.strictObject({ provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL), accountId: cloudflareAccountSchema });
export const evaluationUsageBindingSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('gemini'), model: z.literal(GEMINI_MODEL) }), cloudflareBindingSchema,
]);
export type EvaluationUsageBinding = z.output<typeof evaluationUsageBindingSchema>;
const defaultBinding: EvaluationUsageBinding = { provider: 'gemini', model: GEMINI_MODEL };

const id = z.uuid();
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const micros = z.string().regex(/^(0|[1-9]\d*)$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const timestamp = z.union([z.date(), z.iso.datetime()]).transform(value => new Date(value).toISOString());
// Projection allowlist: unknown DB fields are stripped, never copied into the artifact.
const usage = z.object({ promptTokens: natural, outputTokens: natural, totalTokens: natural,
  cachedTokens: natural.optional(), thoughtTokens: natural.optional() });
const legacyUsageEvidenceSchema = z.object({ schemaVersion: z.literal(1), runId: id,
  invocations: z.array(z.object({ id, reservation_id: id, kind: z.enum(['start', 'resume']),
    model: z.literal(GEMINI_MODEL), status: z.enum(['active', 'expired', 'settled']),
    max_cost_micros: micros, charged_cost_micros: micros, actual_cost_micros: micros.nullable(),
    created_at: timestamp, expires_at: timestamp })).max(2),
  calls: z.array(z.object({ invocation_id: id, call_id: z.string().min(1).max(128),
    status: z.enum(['started', 'completed']), usage: usage.nullable(),
    started_at: timestamp, completed_at: timestamp.nullable() })).max(7),
}).superRefine((value, context) => {
  const ids = new Set(value.invocations.map(i => i.id));
  const calls = new Set(value.calls.map(c => c.call_id));
  if (ids.size !== value.invocations.length || calls.size !== value.calls.length || value.calls.some(c => !ids.has(c.invocation_id))) {
    context.addIssue({ code: 'custom', message: 'EVAL_USAGE_BINDING_INVALID' });
  }
});
const cloudflareUsage = z.strictObject({ promptTokens: natural.max(1_000_000_000), outputTokens: natural.max(1_000_000_000),
  totalTokens: natural.max(1_000_000_000), cachedTokens: natural.max(1_000_000_000).optional() });
const cloudflareEvidence = z.strictObject({ provider: z.literal('cloudflare'), returnedModel: z.string().max(160).nullable(),
  priceBasis: z.literal(CLOUDFLARE_PRICE_BASIS) });
const invocationFields = { id, reservation_id: id, kind: z.enum(['start', 'resume']),
  status: z.enum(['active', 'expired', 'settled']), max_cost_micros: micros,
  charged_cost_micros: micros, actual_cost_micros: micros.nullable(), created_at: timestamp, expires_at: timestamp };
const callFields = { invocation_id: id, call_id: z.string().min(1).max(128), status: z.enum(['started', 'completed']),
  started_at: timestamp, completed_at: timestamp.nullable() };
const cloudflareUsageEvidenceSchema = z.object({ schemaVersion: z.literal(2), runId: id, binding: cloudflareBindingSchema,
  invocations: z.array(z.object({ ...invocationFields, provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL),
    account_id: cloudflareAccountSchema, run_id: id, logical_run_id: id,
    reservation_status: z.enum(['reserved', 'expired', 'settled']) })).max(2),
  calls: z.array(z.object({ ...callFields, run_id: id, usage: cloudflareUsage.nullable(),
    provider_evidence: cloudflareEvidence.nullable() })).max(7),
}).superRefine((value, context) => {
  const ids = new Set(value.invocations.map(row => row.id));
  if (ids.size !== value.invocations.length
    || new Set(value.invocations.map(row => row.reservation_id)).size !== value.invocations.length
    || new Set(value.invocations.map(row => row.kind)).size !== value.invocations.length
    || (value.invocations.length > 0 && !value.invocations.some(row => row.kind === 'start'))
    || value.invocations.some(row => row.run_id !== value.runId || row.logical_run_id !== value.runId || row.account_id !== value.binding.accountId)
    || new Set(value.calls.map(row => row.call_id)).size !== value.calls.length
    || value.calls.some(row => !ids.has(row.invocation_id) || row.run_id !== value.runId
      || (row.status === 'completed') !== (row.completed_at !== null)
      || (row.usage !== null && (row.status !== 'completed'
        || referenceProviderCost('cloudflare', row.usage, row.provider_evidence ?? undefined) === null)))) {
    context.addIssue({ code: 'custom', message: 'EVAL_USAGE_BINDING_INVALID' });
  }
});
// Historical Gemini artifacts retain their original schema and unknown nulls.
export const usageEvidenceSchema = z.union([legacyUsageEvidenceSchema, cloudflareUsageEvidenceSchema]);
export type CloudflareUsageEvidence = z.output<typeof cloudflareUsageEvidenceSchema>;
export type UsageEvidence = z.output<typeof usageEvidenceSchema>;

const snapshotSchema = z.object({
  invocations: z.array(z.object({ ...invocationFields, run_id: id, provider: z.string(), model: z.string(), account_id: z.string().nullable(),
    ledger_reservation_id: id, reservation_owner_id: id, logical_run_id: id,
    reservation_status: z.enum(['reserved', 'expired', 'settled']) })).max(2),
  calls: z.array(z.object({ ...callFields, run_id: id, usage: z.unknown(), provider_evidence: z.unknown() })).max(7),
});

/** Private forensic evidence, not a public API or a reconciliation/settlement action.
 * Only isolated test schemas; one consistent read, bounded by pool DB timeouts.
 * Never export prompts, credentials, raw provider responses, session tokens or IP hashes.
 */
export async function readUsageSnapshot(pool: Pool, ownerId: string, tripId: string, runId: string,
  selected: EvaluationUsageBinding = defaultBinding) {
  [ownerId, tripId, runId].forEach(value => id.parse(value));
  const parsedBinding = evaluationUsageBindingSchema.safeParse(selected);
  if (!parsedBinding.success) throw new Error('EVAL_USAGE_BINDING_INVALID');
  const binding = parsedBinding.data;
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0]?.name;
    if (typeof schema !== 'string' || !/^test_[a-f0-9]{32}$/.test(schema)) throw new Error('EVAL_TEST_SCHEMA_REQUIRED');
    const bound = await client.query(`SELECT r.id FROM agent_runs r JOIN trips t ON t.id=r.trip_id
      WHERE r.id=$1 AND t.id=$2 AND t.owner_id=$3`, [runId, tripId, ownerId]);
    if (!bound.rowCount) throw new Error('EVAL_AUDIT_OWNER_MISMATCH');
    const invocations = await client.query(`SELECT i.id,i.run_id,i.reservation_id,i.kind,i.provider,i.model,i.account_id,i.status,
      i.max_cost_micros,q.id AS ledger_reservation_id,q.owner_id AS reservation_owner_id,q.logical_run_id,q.status AS reservation_status,
      q.charged_cost_micros,q.actual_cost_micros,i.created_at,i.expires_at
      FROM agent_invocations i LEFT JOIN quota_reservations q ON q.id=i.reservation_id
      WHERE i.run_id=$1 ORDER BY i.created_at,i.id LIMIT 3`, [runId]);
    // Include wrongly attached calls as well; filtering only c.run_id hides them.
    const calls = await client.query(`SELECT c.invocation_id,c.run_id,c.call_id,c.status,c.usage,c.provider_evidence,c.started_at,c.completed_at
      FROM model_calls c WHERE c.run_id=$1 OR EXISTS (
        SELECT 1 FROM agent_invocations i WHERE i.id=c.invocation_id AND i.run_id=$1)
      ORDER BY c.started_at,c.call_id LIMIT 8`, [runId]);
    const parsed = snapshotSchema.safeParse({ invocations: invocations.rows, calls: calls.rows });
    if (!parsed.success) throw new Error('EVAL_USAGE_BINDING_INVALID');
    const snapshot = parsed.data;
    const invocationIds = new Set(snapshot.invocations.map(row => row.id));
    if (invocationIds.size !== snapshot.invocations.length
      || new Set(snapshot.invocations.map(row => row.reservation_id)).size !== snapshot.invocations.length
      || new Set(snapshot.invocations.map(row => row.kind)).size !== snapshot.invocations.length
      || (snapshot.invocations.length > 0 && !snapshot.invocations.some(row => row.kind === 'start'))
      || snapshot.invocations.some(row => row.run_id !== runId || row.provider !== binding.provider || row.model !== binding.model
        || row.account_id !== (binding.provider === 'cloudflare' ? binding.accountId : null)
        || row.reservation_id !== row.ledger_reservation_id || row.reservation_owner_id !== ownerId || row.logical_run_id !== runId)
      || new Set(snapshot.calls.map(row => row.call_id)).size !== snapshot.calls.length
      || snapshot.calls.some(row => row.run_id !== runId || !invocationIds.has(row.invocation_id)
        || (row.status === 'completed') !== (row.completed_at !== null))) throw new Error('EVAL_USAGE_BINDING_INVALID');
    const normalized = snapshot.calls.map(row => {
      const parsedUsage = (binding.provider === 'cloudflare' ? cloudflareUsage : usage.strict()).safeParse(row.usage);
      const evidence = cloudflareEvidence.safeParse(row.provider_evidence);
      const providerEvidence = binding.provider === 'cloudflare' && evidence.success ? evidence.data : null;
      const cost = parsedUsage.success && row.status === 'completed'
        ? binding.provider === 'cloudflare' ? referenceProviderCost('cloudflare', parsedUsage.data, providerEvidence ?? undefined)
          : row.provider_evidence == null ? referenceModelCost(parsedUsage.data) : null : null;
      return { ...row, usage: cost === null || !parsedUsage.success ? null : parsedUsage.data, provider_evidence: providerEvidence };
    });
    await client.query('COMMIT');
    return { binding, runId, invocations: snapshot.invocations, calls: normalized };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

/** Projection only: schemaVersion 1 remains Gemini-compatible; Cloudflare is explicit v2. */
export async function exportUsageEvidence(pool: Pool, ownerId: string, tripId: string, runId: string,
  binding: EvaluationUsageBinding = defaultBinding): Promise<UsageEvidence> {
  const snapshot = await readUsageSnapshot(pool, ownerId, tripId, runId, binding);
  return usageEvidenceSchema.parse({ schemaVersion: snapshot.binding.provider === 'cloudflare' ? 2 : 1,
    ...(snapshot.binding.provider === 'cloudflare' ? { binding: snapshot.binding } : {}), runId,
    invocations: snapshot.invocations, calls: snapshot.calls });
}
