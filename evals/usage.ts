import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { referenceModelCost, referenceProviderCost } from '../src/server/model-cost.ts';
import type { UsageAudit } from './collector.ts';
import { readUsageSnapshot, type EvaluationUsageBinding } from './usage-evidence.ts';
import { productDecisionReceiptSchema, type ProductDecisionReceipt } from './replay-bundle.ts';

export type { EvaluationUsageBinding } from './usage-evidence.ts';

type UsageSnapshot = Awaited<ReturnType<typeof readUsageSnapshot>>;
type ReconciliationPolicy = { version: 1 } | { version: 2; verifiedZeroResumeInvocationId: string | null };

/** Pure reconciliation shared by both audit versions. Legacy empty invocations
 * remain unknown; v2 permits only the exact resume independently proven below.
 * Neither policy bypasses per-invocation settlement/reference-cost equality. */
function reconcileUsage(snapshot: UsageSnapshot, policy: ReconciliationPolicy): UsageAudit {
  let complete = snapshot.invocations.length > 0 && snapshot.calls.length > 0;
  let cost = 0;
  for (const invocation of snapshot.invocations) {
    const calls = snapshot.calls.filter(row => row.invocation_id === invocation.id);
    const verifiedZeroResume = policy.version === 2 && policy.verifiedZeroResumeInvocationId === invocation.id
      && invocation.kind === 'resume' && snapshot.invocations.length === 2;
    let subtotal = 0, known = calls.length > 0 || verifiedZeroResume;
    for (const call of calls) {
      const value = snapshot.binding.provider === 'cloudflare'
        ? referenceProviderCost('cloudflare', call.usage, call.provider_evidence ?? undefined) : referenceModelCost(call.usage);
      if (call.status !== 'completed' || value === null || !Number.isSafeInteger(subtotal + value)) known = false;
      else subtotal += value;
    }
    if (!known || invocation.status !== 'settled' || invocation.reservation_status !== 'settled'
      || invocation.actual_cost_micros === null || BigInt(invocation.actual_cost_micros) !== BigInt(subtotal)
      || BigInt(invocation.charged_cost_micros) !== BigInt(subtotal) || !Number.isSafeInteger(cost + subtotal)) complete = false;
    else cost += subtotal;
  }
  return { model: snapshot.binding.model, runId: snapshot.runId, complete,
    modelCalls: snapshot.calls.length, costMicros: complete ? cost : null };
}

/** Private read-only audit. The caller's pool is scoped to its isolated test schema.
 * Never expose this helper as a public endpoint. Historical output is unchanged. */
export async function auditUsage(pool: Pool, ownerId: string, tripId: string, runId: string,
  binding?: EvaluationUsageBinding): Promise<UsageAudit> {
  return reconcileUsage(await readUsageSnapshot(pool, ownerId, tripId, runId, binding), { version: 1 });
}

const nativeSummarySchema = z.strictObject({ event_count: z.number().int().min(0).max(129),
  model_events: z.number().int().nonnegative(), tool_calls: z.number().int().nonnegative(),
  invalid: z.boolean(), fault_observed: z.boolean() });

/** Same SSOT as version-store: an immutable apply receipt or rejection_version,
 * NOT current_version. Only fixed receipt metadata leaves this SQL statement. */
async function productReceipt(client: PoolClient, ownerId: string, tripId: string, runId: string,
  baseVersion: number, proposalId: string): Promise<ProductDecisionReceipt | null> {
  const hash = createHash('sha256').update(JSON.stringify(['apply', tripId, baseVersion, proposalId])).digest('hex');
  const raw = (await client.query(`WITH decision AS (
    SELECT r.id,r.base_version,r.decision,p.status,p.rejection_version,
      m.owner_id IS NOT NULL AS has_apply_receipt,
      COALESCE(p.status='applied' AND m.payload_hash=$4
        AND m.response->>'id'=$2::text AND m.response->'version'=to_jsonb(r.base_version::bigint+1),false) AS applied_valid,
      p.rejection_version IS NOT NULL AND p.rejection_version>=r.base_version AS rejected_valid
    FROM agent_runs r JOIN trips t ON t.id=r.trip_id JOIN proposals p ON p.id=r.proposal_id
    LEFT JOIN mutation_receipts m ON m.owner_id=t.owner_id AND m.trip_id=r.trip_id
      AND m.request_id='agent:'||r.id::text AND m.operation='apply'
    WHERE r.id=$1::uuid AND r.trip_id=$2::uuid AND t.owner_id=$3::uuid AND r.answer_contract_version=1
      AND p.trip_id=r.trip_id AND p.base_version=r.base_version AND r.decision IS NOT NULL
  ) SELECT CASE WHEN decision AND applied_valid THEN jsonb_build_object('runId',id,'status','applied','version',base_version::bigint+1)
      WHEN NOT decision AND status='rejected' AND rejected_valid
        THEN jsonb_build_object('runId',id,'status','rejected','version',rejection_version) ELSE NULL END AS receipt,
    ((decision AND (status='applied' OR has_apply_receipt) AND NOT applied_valid)
      OR (NOT decision AND status='rejected' AND NOT rejected_valid)) AS invalid FROM decision`,
  [runId, tripId, ownerId, hash])).rows;
  if (!raw.length) return null;
  const parsed = z.strictObject({ receipt: productDecisionReceiptSchema.nullable(), invalid: z.literal(false) }).safeParse(raw[0]);
  if (raw.length !== 1 || !parsed.success) throw new Error('EVAL_PRODUCT_RECEIPT_INVALID');
  return parsed.data.receipt;
}

async function zeroResumeProof(client: PoolClient, schema: string, ownerId: string, tripId: string,
  runId: string, receipt: ProductDecisionReceipt): Promise<boolean> {
  // This proves a frozen invocation, not the trip's current state. A later
  // manual update must not invalidate an already settled zero-cost receipt.
  const row = (await client.query(`WITH phase AS (
    SELECT sequence,event->>'runId' AS request_id,event->>'threadId' AS trip_id FROM agent_run_events
    WHERE run_id=$1::uuid AND event->>'type'='RUN_STARTED' ORDER BY sequence DESC LIMIT 1
  ), phase_events AS (
    SELECT e.sequence,e.event FROM agent_run_events e,phase p WHERE e.run_id=$1::uuid AND e.sequence>p.sequence
  ), answer AS (
    SELECT sequence,event FROM phase_events WHERE event->>'type'='CUSTOM'
  ), terminal AS (
    SELECT sequence,event FROM phase_events ORDER BY sequence DESC LIMIT 1
  ), native AS (
    SELECT invocation_id,event_data::jsonb AS d FROM "${schema}_adk".events
    WHERE session_id=$1::text AND user_id=$3::text AND app_name='dive_trip_fixture'
    ORDER BY timestamp,id LIMIT 129
  ) SELECT EXISTS (
    SELECT 1 FROM agent_runs r JOIN trips t ON t.id=r.trip_id
    JOIN agent_invocations i ON i.run_id=r.id AND i.kind='resume'
    JOIN quota_reservations q ON q.id=i.reservation_id,phase p,answer a,terminal f
    WHERE r.id=$1::uuid AND r.trip_id=$2::uuid AND t.owner_id=$3::uuid
      AND r.answer_contract_version=1 AND r.status='succeeded' AND r.proposal_tool_call_id IS NOT NULL
      AND i.status='settled' AND q.status='settled' AND q.actual_cost_micros=0 AND q.charged_cost_micros=0
      AND q.owner_id=t.owner_id AND q.logical_run_id=r.id
      AND NOT EXISTS (SELECT 1 FROM model_calls c WHERE c.invocation_id=i.id)
      AND r.decision=($4::jsonb->>'status'='applied')
      AND p.trip_id=$2::text AND p.request_id<>r.request_id
      AND (SELECT count(*) FROM answer)=1 AND a.event->>'name'='dive_trip.answer.v1'
      AND a.event#>'{value,schemaVersion}'='1'::jsonb AND a.event#>'{value,templateVersion}'='1'::jsonb
      AND a.event#>>'{value,runId}'=$1::text
      AND a.event#>>'{value,answerId}' ~ '^ans_[a-f0-9]{64}$'
      AND jsonb_array_length(CASE WHEN jsonb_typeof(a.event#>'{value,evidenceRefs}')='array'
        THEN a.event#>'{value,evidenceRefs}' ELSE '[]'::jsonb END)=1
      AND a.event#>>'{value,evidenceRefs,0}' ~ '^ev_[a-f0-9]{64}$'
      AND a.event#>'{value,body}'=jsonb_build_object('kind','receipt','status',$4::jsonb->'status','version',$4::jsonb->'version')
      AND f.sequence>a.sequence AND f.event->>'type'='RUN_FINISHED'
      AND f.event->>'runId'=p.request_id AND f.event->>'threadId'=$2::text
      AND (f.event->'outcome' IS NULL OR f.event#>>'{outcome,type}'='success')
      AND NOT EXISTS (SELECT 1 FROM phase_events WHERE event->>'type' IN ('RUN_STARTED','RUN_ERROR'))
      AND EXISTS (SELECT 1 FROM agent_run_events e WHERE e.run_id=r.id AND e.sequence<p.sequence AND e.event->>'type'='RUN_STARTED')
      AND NOT EXISTS (SELECT 1 FROM agent_run_events e WHERE e.run_id=r.id AND e.sequence<p.sequence
        AND e.event#>>'{value,answerId}'=a.event#>>'{value,answerId}')
      AND (SELECT count(*) FROM native n WHERE n.d->>'author'='dive_trip_fixture'
        AND COALESCE(n.d->>'partial','false')='false' AND n.d#>>'{content,role}'='user'
        AND n.invocation_id IS NOT NULL AND COALESCE(n.d->>'interrupted','false')='false'
        AND COALESCE(n.d->>'error_code','')=''
        AND n.d#>'{actions,skip_summarization}'='true'::jsonb
        AND n.d#>'{actions,state_delta,acceptedAnswerV1}'=a.event->'value'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(n.d#>'{content,parts}')='array'
          THEN n.d#>'{content,parts}' ELSE '[]'::jsonb END)=1
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.d#>'{content,parts}')='array'
          THEN n.d#>'{content,parts}' ELSE '[]'::jsonb END) part
          WHERE part#>>'{function_response,name}'='propose_changes'
            AND part#>>'{function_response,id}'=r.proposal_tool_call_id
            AND part#>'{function_response,response,status}'=$4::jsonb->'status'
            AND part#>'{function_response,response,version}'=$4::jsonb->'version'
            AND part#>>'{function_response,response,answerEvidenceRef}'=a.event#>>'{value,evidenceRefs,0}')
        AND NOT EXISTS (SELECT 1 FROM native other WHERE other.invocation_id=n.invocation_id
          AND (other.d#>>'{content,role}'='model' OR COALESCE(other.d->>'error_code','')<>''
            OR COALESCE(other.d->>'interrupted','false')<>'false'
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(other.d#>'{content,parts}')='array'
              THEN other.d#>'{content,parts}' ELSE '[]'::jsonb END) part WHERE part ? 'function_call'))))=1
  ) AS zero_resume_verified`, [runId, tripId, ownerId, JSON.stringify(receipt)])).rows[0];
  const result = z.strictObject({ zero_resume_verified: z.boolean() }).safeParse(row);
  return result.success && result.data.zero_resume_verified;
}

/** New collector only. Legacy auditUsage/exportUsageEvidence keep their exact output.
 * SQL returns fixed booleans/counts from the bound native session, never raw
 * args/text/responses/state. No ADK initialization or accounting/history writes. */
export async function auditAcceptedAnswerUsage(pool: Pool, ownerId: string, tripId: string, runId: string,
  binding?: EvaluationUsageBinding): Promise<UsageAudit> {
  const snapshot = await readUsageSnapshot(pool, ownerId, tripId, runId, binding);
  const client = await pool.connect();
  let discard = false;
  let nativeToolCalls: number | null = null;
  let faultObserved: 'catalog-timeout' | null = null;
  let decisionReceipt: ProductDecisionReceipt | null = null;
  let verifiedZeroResumeInvocationId: string | null = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0]?.name;
    if (typeof schema !== 'string' || !/^test_[a-f0-9]{32}$/.test(schema)) throw new Error('EVAL_TEST_SCHEMA_REQUIRED');
    const bound = (await client.query(`SELECT r.answer_contract_version,r.base_version,r.proposal_id,r.decision,r.status,
      r.status <> 'running' AND NOT EXISTS (SELECT 1 FROM agent_invocations i WHERE i.run_id=r.id AND i.status='active') AS quiescent
      FROM agent_runs r JOIN trips t ON t.id=r.trip_id WHERE r.id=$1 AND t.id=$2 AND t.owner_id=$3`,
    [runId, tripId, ownerId])).rows;
    if (bound.length !== 1) throw new Error('EVAL_AUDIT_OWNER_MISMATCH');
    const tables = (await client.query('SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS present',
      [`${schema}_adk.sessions`, `${schema}_adk.events`])).rows[0];
    if (bound[0].answer_contract_version === 1 && bound[0].quiescent === true && tables?.present === true) {
      if (bound[0].decision === true || bound[0].decision === false) {
        decisionReceipt = await productReceipt(client, ownerId, tripId, runId,
          z.number().int().positive().parse(bound[0].base_version), z.uuid().parse(bound[0].proposal_id));
      }
      const session = (await client.query(`SELECT count(*)::int AS matches FROM "${schema}_adk".sessions
        WHERE id=$1 AND app_name='dive_trip_fixture' AND user_id=$2
          AND state->>'answerContractVersion'='1' AND state->>'providerMode'=$3
          AND (state->>'providerAccountId') IS NOT DISTINCT FROM $4::text
          AND state->>'providerModel'=$5`,
      [runId, ownerId, snapshot.binding.provider,
        snapshot.binding.provider === 'cloudflare' ? snapshot.binding.accountId : null, snapshot.binding.model])).rows[0];
      if (session?.matches === 1) {
        // ADK 2.1 stores snake_case event fields but preserves state_delta keys.
        // Its final tool becomes model JSON + skip_summarization; count that
        // marker only with the server's run-bound acceptedAnswerV1 metadata.
        const raw = (await client.query(`WITH bounded_events AS (
          SELECT event_data::jsonb AS d FROM "${schema}_adk".events
          WHERE session_id=$1 AND user_id=$2 AND app_name='dive_trip_fixture'
          ORDER BY timestamp,id LIMIT 129
        ), eligible AS (
          SELECT d FROM bounded_events WHERE d->>'author'='dive_trip_fixture' AND COALESCE(d->>'partial','false')='false'
        ), parts AS (
          SELECT d,p FROM eligible CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(d#>'{content,parts}')='array' THEN d#>'{content,parts}' ELSE '[]'::jsonb END) p
        ), calls AS (
          SELECT p#>>'{function_call,id}' AS id,p#>>'{function_call,name}' AS name FROM parts
          WHERE p ? 'function_call' AND p#>>'{function_call,name}' IS DISTINCT FROM 'adk_request_confirmation'
        ), finals AS (
          SELECT d FROM eligible WHERE d#>>'{content,role}'='model' AND d#>'{actions,skip_summarization}'='true'::jsonb
            AND NOT EXISTS (SELECT 1 FROM parts WHERE parts.d=eligible.d AND (p ? 'function_call' OR p ? 'function_response'))
        ) SELECT
          (SELECT count(*)::int FROM bounded_events) AS event_count,
          (SELECT count(*)::int FROM eligible WHERE d#>>'{content,role}'='model') AS model_events,
          ((SELECT count(*) FROM calls)+(SELECT count(*) FROM finals))::int AS tool_calls,
          (EXISTS (SELECT 1 FROM bounded_events WHERE COALESCE(d->>'partial','false') <> 'false'
              OR COALESCE(d->>'author','') NOT IN ('user','dive_trip_fixture')
              OR (d#>'{content,parts}' IS NOT NULL AND jsonb_typeof(d#>'{content,parts}') <> 'array'))
            OR EXISTS (SELECT 1 FROM calls WHERE id IS NULL OR id='' OR name IS NULL OR name NOT IN
              ('find_destinations','find_items','calculate_budget','validate_changes','propose_changes','set_model_response'))
            OR (SELECT count(*)<>count(DISTINCT id) FROM calls)
            OR EXISTS (SELECT 1 FROM finals WHERE (d#>>'{actions,state_delta,acceptedAnswerV1,runId}') IS DISTINCT FROM $1
              OR (d#>'{actions,state_delta,acceptedAnswerV1,schemaVersion}') IS DISTINCT FROM '1'::jsonb
              OR (d#>'{actions,state_delta,acceptedAnswerV1,templateVersion}') IS DISTINCT FROM '1'::jsonb)) AS invalid,
          EXISTS (SELECT 1 FROM parts JOIN calls ON calls.id=p#>>'{function_response,id}' AND calls.name='find_items'
            WHERE p#>>'{function_response,name}'='find_items' AND p#>>'{function_response,response,error}'='CATALOG_TIMEOUT') AS fault_observed`,
        [runId, ownerId])).rows[0];
        const parsed = nativeSummarySchema.safeParse(raw);
        if (parsed.success && !parsed.data.invalid && parsed.data.event_count > 0 && parsed.data.event_count <= 128
          && parsed.data.model_events === snapshot.calls.length) {
          nativeToolCalls = parsed.data.tool_calls;
          faultObserved = parsed.data.fault_observed ? 'catalog-timeout' : null;
          const emptyResume = snapshot.invocations.find(row => row.kind === 'resume'
            && !snapshot.calls.some(call => call.invocation_id === row.id));
          if (emptyResume && decisionReceipt && bound[0].status === 'succeeded'
            && await zeroResumeProof(client, schema, ownerId, tripId, runId, decisionReceipt)) {
            verifiedZeroResumeInvocationId = emptyResume.id;
          }
        }
      }
    }
    await client.query('COMMIT');
    const usage = reconcileUsage(snapshot, { version: 2, verifiedZeroResumeInvocationId });
    return { ...usage, nativeToolCalls, faultObserved, decisionReceipt };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
