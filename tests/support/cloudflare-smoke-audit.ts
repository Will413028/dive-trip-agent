import type { Pool } from 'pg';
import { z } from 'zod';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../../src/agent/cloudflare-wire.ts';
import { providerAccountingEvidenceSchema } from '../../src/agent/provider-contract.ts';
import { referenceProviderCost } from '../../src/server/model-cost.ts';
import { withCloudflareAuditDatabase } from './cloudflare-audit-database.ts';

export type SmokeTokens = { promptTokens: number; outputTokens: number; totalTokens: number };
export type SanitizedSmokeInvocation = {
  index: number; kind: 'start' | 'resume' | 'unknown'; settled: boolean; bindingValid: boolean;
  ledgerMatches: boolean; costMicros: number | null; actualCostMicros: number | null; chargedCostMicros: number | null;
};
export type SanitizedSmokeCall = {
  index: number; invocation: number | null; completed: boolean; bindingValid: boolean;
  costMicros: number | null; tokens: SmokeTokens | null;
};
export type CloudflareSmokeAudit = {
  complete: boolean; modelCalls: number; runId: string | null; costMicros: number | null; tokens: SmokeTokens | null;
  invocations: SanitizedSmokeInvocation[]; calls: SanitizedSmokeCall[];
};

const count = z.number().int().min(0).max(1_000_000_000);
// Persisted Cloudflare usage has already removed inclusive reasoning tokens.
const usageSchema = z.strictObject({ promptTokens: count, outputTokens: count, totalTokens: count,
  cachedTokens: count.optional() });
const money = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).refine(Number.isSafeInteger)]);
const invocationSchema = z.object({ id: z.uuid(), run_id: z.uuid(), reservation_id: z.uuid(),
  provider: z.string(), model: z.string(), account_id: z.string().nullable(), kind: z.enum(['start', 'resume']),
  status: z.string(), reservation_status: z.string(), logical_run_id: z.uuid().nullable(),
  actual_cost_micros: money.nullable(), charged_cost_micros: money });
const callSchema = z.object({ invocation_id: z.uuid(), run_id: z.uuid(), call_id: z.string().min(1).max(128),
  status: z.string(), usage: z.unknown(), provider_evidence: z.unknown() });
const empty = (): CloudflareSmokeAudit => ({ complete: false, modelCalls: 0, runId: null,
  costMicros: null, tokens: null, invocations: [], calls: [] });

/** Pure validator; rows are the explicit SQL projections below, never raw model responses.
 * All output is built from allowlisted fields, including when input is malformed. */
export function validateCloudflareSmokeAudit(rows: unknown, expectedAccountId: string): CloudflareSmokeAudit {
  const parsed = z.object({ invocations: z.array(z.unknown()).max(3), calls: z.array(z.unknown()).max(8) }).safeParse(rows);
  if (!parsed.success || !cloudflareAccountSchema.safeParse(expectedAccountId).success) return empty();
  const invocations = parsed.data.invocations.map(row => invocationSchema.safeParse(row));
  const calls = parsed.data.calls.map(row => callSchema.safeParse(row));
  const bound = invocations.map(row => row.success && row.data.provider === 'cloudflare'
    && row.data.model === CLOUDFLARE_MODEL && row.data.account_id === expectedAccountId
    && row.data.logical_run_id === row.data.run_id);
  const sanitizedCalls: SanitizedSmokeCall[] = calls.map((row, index) => {
    const fallback: SanitizedSmokeCall = { index, invocation: null, completed: false, bindingValid: false, costMicros: null, tokens: null };
    if (!row.success) return fallback;
    const call = row.data;
    const parent = invocations.findIndex(inv => inv.success && inv.data.id === call.invocation_id && inv.data.run_id === call.run_id);
    const usage = usageSchema.safeParse(call.usage);
    const evidence = providerAccountingEvidenceSchema.safeParse(call.provider_evidence);
    const cost = parent >= 0 && bound[parent] && usage.success && evidence.success
      ? referenceProviderCost('cloudflare', usage.data, evidence.data) : null;
    const known = call.status === 'completed' && cost !== null;
    return { index, invocation: parent < 0 ? null : parent, completed: call.status === 'completed',
      bindingValid: parent >= 0 && bound[parent] && evidence.success && evidence.data.provider === 'cloudflare' && cost !== null,
      costMicros: known ? cost : null,
      tokens: known && usage.success ? { promptTokens: usage.data.promptTokens,
        outputTokens: usage.data.outputTokens, totalTokens: usage.data.totalTokens } : null };
  });
  const sanitizedInvocations: SanitizedSmokeInvocation[] = invocations.map((row, index) => {
    const children = sanitizedCalls.filter(call => call.invocation === index);
    const known = children.length > 0 && children.every(call => call.costMicros !== null);
    const cost = known ? children.reduce((sum, call) => sum + call.costMicros!, 0) : null;
    const actual = row.success ? row.data.actual_cost_micros : null;
    const charged = row.success ? row.data.charged_cost_micros : null;
    return { index, kind: row.success ? row.data.kind : 'unknown',
      settled: row.success && row.data.status === 'settled' && row.data.reservation_status === 'settled',
      bindingValid: bound[index], ledgerMatches: cost !== null && cost === actual && cost === charged,
      costMicros: cost, actualCostMicros: actual, chargedCostMicros: charged };
  });
  const validRows = invocations.flatMap(row => row.success ? [row.data] : []);
  const validCalls = calls.flatMap(row => row.success ? [row.data] : []);
  const complete = invocations.length >= 1 && invocations.length <= 2 && calls.length >= 1 && calls.length <= 7
    && sanitizedInvocations.every(row => row.settled && row.bindingValid && row.ledgerMatches)
    && sanitizedCalls.every(row => row.completed && row.bindingValid && row.costMicros !== null)
    && new Set(validRows.map(row => row.id)).size === invocations.length
    && new Set(validRows.map(row => row.reservation_id)).size === invocations.length
    && new Set(validRows.map(row => row.run_id)).size === 1
    && validRows.filter(row => row.kind === 'start').length === 1
    && new Set(validRows.map(row => row.kind)).size === invocations.length
    && new Set(validCalls.map(row => row.call_id)).size === calls.length;
  const runIds = new Set(validRows.map(row => row.run_id));
  return { complete, modelCalls: calls.length,
    runId: validRows.length === invocations.length && runIds.size === 1 ? validRows[0].run_id : null,
    costMicros: complete ? sanitizedCalls.reduce((sum, call) => sum + call.costMicros!, 0) : null,
    tokens: complete ? sanitizedCalls.reduce((sum, call) => ({ promptTokens: sum.promptTokens + call.tokens!.promptTokens,
      outputTokens: sum.outputTokens + call.tokens!.outputTokens, totalTokens: sum.totalTokens + call.tokens!.totalTokens }),
    { promptTokens: 0, outputTokens: 0, totalTokens: 0 }) : null,
    invocations: sanitizedInvocations, calls: sanitizedCalls };
}

/** Runner preflight only; audit repeats this check on its own connection. */
export async function verifyCloudflareSmokeDatabase(pool: Pool): Promise<void> {
  try { await withCloudflareAuditDatabase(pool, async () => {}); }
  catch { throw new Error('CLOUDFLARE_SMOKE_AUDIT_FAILED'); }
}

/** No schema override, credentials, env loading, writes or model requests.
 * At most three invocation rows/eight calls: the extra row proves overflow.
 * Destroying the dedicated connection also aborts the read-only transaction. */
export async function auditCloudflareSmoke(pool: Pool, tripId: string, expectedAccountId: string): Promise<CloudflareSmokeAudit> {
  if (!z.uuid().safeParse(tripId).success || !cloudflareAccountSchema.safeParse(expectedAccountId).success) {
    throw new Error('CLOUDFLARE_SMOKE_AUDIT_INPUT');
  }
  try {
    return await withCloudflareAuditDatabase(pool, async query => {
      const invocations = await query(`SELECT i.id,i.run_id,i.reservation_id,i.provider,i.model,i.account_id,i.kind,i.status,
        q.status AS reservation_status,q.logical_run_id,q.actual_cost_micros,q.charged_cost_micros
        FROM workbench_live.agent_invocations i JOIN workbench_live.agent_runs r ON r.id=i.run_id
        LEFT JOIN workbench_live.quota_reservations q ON q.id=i.reservation_id
        WHERE r.trip_id=$1 ORDER BY i.created_at,i.id LIMIT 3`, [tripId]);
      const calls = await query(`SELECT c.invocation_id,c.run_id,c.call_id,c.status,c.usage,c.provider_evidence
        FROM workbench_live.model_calls c
        WHERE EXISTS (SELECT 1 FROM workbench_live.agent_runs r WHERE r.id=c.run_id AND r.trip_id=$1)
          OR EXISTS (SELECT 1 FROM workbench_live.agent_invocations i JOIN workbench_live.agent_runs r ON r.id=i.run_id
            WHERE i.id=c.invocation_id AND r.trip_id=$1)
        ORDER BY c.started_at,c.call_id LIMIT 8`, [tripId]);
      return validateCloudflareSmokeAudit({ invocations: invocations.rows, calls: calls.rows }, expectedAccountId);
    });
  } catch {
    // Never propagate SQL, connection details, account identity or row payloads.
    throw new Error('CLOUDFLARE_SMOKE_AUDIT_FAILED');
  }
}
