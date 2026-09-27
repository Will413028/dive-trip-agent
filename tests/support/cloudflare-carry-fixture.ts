import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';

export function fixture() {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const accountId = '1fd574e905257afa3cfd7db80cf70b23';
  const runs = ['81a6eb61-7188-48d6-8e37-b07715433b4d', '1587fc58-9bb9-4b26-8851-90a2933ec1ee'].map((id, i) => ({
    id, status: i ? 'failed' : 'succeeded', proposal_id: null, interrupt_id: null, decision: null,
  }));
  const usage = runs.map((run, i) => ({ schemaVersion: 2, runId: run.id,
    binding: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId },
    invocations: [{ id: id(10 + i), reservation_id: i ? '3d7f1f07-d513-46e5-8f82-7415671339e2' : id(20),
      run_id: run.id, logical_run_id: run.id, provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: accountId,
      kind: 'start', status: 'settled', reservation_status: 'settled', max_cost_micros: '183505',
      charged_cost_micros: i ? '183505' : '786', actual_cost_micros: i ? null : '786',
      created_at: '2026-09-26T05:00:00.000Z', expires_at: '2026-09-26T05:01:00.000Z' }],
    calls: [{ invocation_id: id(10 + i), run_id: run.id, call_id: `synthetic-${i}`, status: 'completed',
      usage: { promptTokens: i ? 4205 : 4201, outputTokens: i ? 639 : 1217, totalTokens: i ? 4844 : 5418 },
      provider_evidence: { provider: 'cloudflare', returnedModel: CLOUDFLARE_MODEL, priceBasis: CLOUDFLARE_PRICE_BASIS },
      started_at: '2026-09-26T05:00:00.000Z', completed_at: '2026-09-26T05:00:10.000Z' }],
  }));
  const events = runs.map((r, i) => ({ run_id: r.id, sequence: 1, event: { type: i ? 'RUN_ERROR' : 'RUN_FINISHED' } }));
  const prior = { chargedMicros: 3976, invocations: 6, modelCalls: 9, totalTokens: 36403 };
  const history = Array.from({ length: 4 }, (_, i) => ({ name: `synthetic-${i}`, sha256: String(i).repeat(64) }));
  const report = { model: CLOUDFLARE_MODEL, accountId, prior, history, stopped: 'UNKNOWN_USAGE_STOP', totalTokens: null,
    cumulativeTokens: null, textReview: 'pending', evaluationGatePassed: false, chargedMicros: 184291,
    modelCalls: 2, cumulativeChargedMicros: 188267, cumulativeInvocations: 8, cumulativeModelCalls: 11,
    records: [...runs.map((r, i) => ({ kind: 'durable-audit', runs: [r], events: [events[i]], privateUsage: [usage[i]],
      privateUsageComplete: true, quiescent: true })), ...Array(30).fill(null)] };
  return { report: structuredClone(report), baseline: { ...prior, history: structuredClone(history) }, snapshot: {
    counts: { runs: 2, trips: 2, invocations: 2, calls: 2, reservations: 2 },
    runs: runs.map((r, i) => ({ ...r,
      trip_id: ['9186a471-201b-4a67-8c9b-e14278e2705f', '64db0940-6c0f-4ca4-85d4-eaf4aea57aa5'][i],
      owner_id: ['a1109568-64ae-4719-8ad6-bbcb033c828a', 'b1d49441-9aed-451a-85c4-292d79e9a7ec'][i], current_version: 1 })),
    events: structuredClone(events), usage: structuredClone(usage),
  } };
}
