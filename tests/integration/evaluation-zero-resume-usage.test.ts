import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { auditAcceptedAnswerUsage, auditUsage } from '../../evals/usage';
import { exportUsageEvidence } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { database } from '../../src/server/db';
import { restoreVersion } from '../../src/server/version-store';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';

// Real isolated HTTP/native ADK/product receipt/ledger; provider fetch is the
// existing fixed synthetic scenario. Never opt in to live/model credentials.
test('known zero-call native resume stays known after later trip updates; missing proof stays unknown', () => withDatabase(async () => {
  const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32) } as const;
  const ports = createCloudflareCampaignPorts({ accountId: binding.accountId, priorChargedMicros: 188267,
    offlineScenario: 'proposal', loadCredential: async () => 'offline-placeholder-not-a-credential' });
  const result = await ports.execute('free-afternoon', async signal => { signal.throwIfAborted(); });
  const runId = result.evidence.runId;
  const product = (await database().query<{ trip_id: string; owner_id: string }>(
    'SELECT r.trip_id,t.owner_id FROM agent_runs r JOIN trips t ON t.id=r.trip_id WHERE r.id=$1', [runId])).rows[0];
  const args = [database(), product.owner_id, product.trip_id, runId, binding] as const;
  const exported = await exportUsageEvidence(...args);
  expect(result.evidence).toMatchObject({ modelCalls: 2, toolCount: 2, visibleToolCount: 2, usageComplete: true });
  expect(exported.invocations).toHaveLength(2);
  const resumed = exported.invocations.find(row => row.kind === 'resume')!;
  expect(resumed).toMatchObject({ actual_cost_micros: '0', charged_cost_micros: '0', status: 'settled' });
  expect(exported.calls.filter(row => row.invocation_id === resumed.id)).toEqual([]);
  const known = await auditAcceptedAnswerUsage(...args);
  expect(known).toMatchObject({ complete: true, modelCalls: 2, nativeToolCalls: 2,
    decisionReceipt: { runId, status: 'applied', version: 2 } });
  expect(known.costMicros).toBeGreaterThan(0);
  expect(await auditUsage(...args)).toMatchObject({ complete: false, costMicros: null });
  expect(await ports.capture()).toMatchObject({ usageKnown: true, privateUsageComplete: true, modelCalls: 2 });
  expect(await exportUsageEvidence(...args)).toEqual(exported); // Auditing never rewrites the historical-format export.

  // A later manual restore creates v3; the immutable agent decision is still v2.
  const later = await restoreVersion(product.owner_id, { tripId: product.trip_id, targetVersion: 1,
    baseVersion: 2, requestId: randomUUID() });
  expect(later.version).toBe(3);
  expect(await auditAcceptedAnswerUsage(...args)).toEqual(known);

  const schema = (await database().query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name;
  if (!/^test_[a-f0-9]{32}$/.test(schema)) throw new Error('EVAL_TEST_SCHEMA_REQUIRED');
  // Tamper only fixed metadata in this test's disposable rows, then restore it.
  // No raw native data is fetched or exposed to assertion output.
  for (const marker of [false, true]) {
    const changed = await database().query(`UPDATE "${schema}_adk".events
      SET event_data=jsonb_set(event_data::jsonb,'{actions,skip_summarization}',$2::jsonb)
      WHERE session_id=$1 AND event_data::jsonb#>>'{actions,state_delta,acceptedAnswerV1,body,kind}'='receipt'`,
    [runId, JSON.stringify(marker)]);
    expect(changed.rowCount).toBe(1);
    expect(await auditAcceptedAnswerUsage(...args)).toMatchObject({ complete: marker, costMicros: marker ? known.costMicros : null });
  }
  for (const version of [999, 2]) {
    const changed = await database().query(`UPDATE agent_run_events
      SET event=jsonb_set(event,'{value,body,version}',$2::jsonb)
      WHERE run_id=$1 AND event->>'name'='dive_trip.answer.v1' AND event#>>'{value,body,kind}'='receipt'`,
    [runId, JSON.stringify(version)]);
    expect(changed.rowCount).toBe(1);
    expect(await auditAcceptedAnswerUsage(...args)).toMatchObject({ complete: version === 2, costMicros: version === 2 ? known.costMicros : null });
  }
  await database().query('UPDATE quota_reservations SET actual_cost_micros=NULL,charged_cost_micros=max_cost_micros WHERE id=$1',
    [resumed.reservation_id]);
  expect(await auditAcceptedAnswerUsage(...args)).toMatchObject({ complete: false, costMicros: null });
  await database().query('UPDATE quota_reservations SET actual_cost_micros=0,charged_cost_micros=0 WHERE id=$1', [resumed.reservation_id]);
  await database().query("UPDATE agent_runs SET status='failed' WHERE id=$1", [runId]);
  expect(await auditAcceptedAnswerUsage(...args)).toMatchObject({ complete: false, costMicros: null });
  await database().query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [runId]);
  await database().query(`UPDATE mutation_receipts SET response=jsonb_set(response,'{version}','999'::jsonb)
    WHERE owner_id=$1 AND request_id=$2`, [product.owner_id, `agent:${runId}`]);
  await expect(auditAcceptedAnswerUsage(...args)).rejects.toThrow('EVAL_PRODUCT_RECEIPT_INVALID');
  await database().query(`UPDATE mutation_receipts SET response=jsonb_set(response,'{version}','2'::jsonb)
    WHERE owner_id=$1 AND request_id=$2`, [product.owner_id, `agent:${runId}`]);
  expect(await auditAcceptedAnswerUsage(...args)).toEqual(known);
  expect(await auditUsage(...args)).toMatchObject({ complete: false, costMicros: null });
  expect(await exportUsageEvidence(...args)).toEqual(exported);
}), 90_000);
