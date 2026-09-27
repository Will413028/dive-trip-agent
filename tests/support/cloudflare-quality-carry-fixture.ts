import { PATCH_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
import { fixture as carryFixture } from './cloudflare-carry-fixture';

export const syntheticId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export type QualityEvent = { run_id: string; sequence: number; event: Record<string, unknown> };
type Run = { id: string; status: string; proposal_id: string | null; interrupt_id: string | null; decision: boolean | null };
type Snapshot = { label: string; requirements: { divers: number }; entries: unknown[] };
export type QualityAttempt = { kind: 'attempt'; round: number; caseId: string;
  evidence: { runId: string; afterVersion: number; after: Snapshot } };
export type QualityAudit = { kind: 'durable-audit'; round: number; caseId: string; runs: Run[];
  events: QualityEvent[]; privateUsage: CloudflareUsageEvidence[]; chargedMicros: number;
  privateUsageComplete: boolean; quiescent: boolean };
type Skip = { kind: 'skip'; round: number; caseId: string; reason: string };

/** Entirely synthetic; only the existing in-memory usage template is reused.
 * IDs deliberately differ from historical provenance, which belongs to IO tests.
 * Costs below are independent expected values, not computed with production code.
 */
export function qualityCarryFixture() {
  const template = carryFixture().snapshot.usage[0];
  const prior = { sourceSha256: PATCH_REPORT_SHA256(), historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 1, invocations: 10, modelCalls: 14, chargedMicros: 190067,
    observedTokens: 61192, totalTokens: null, remainingInvocationCeiling: 90, remainingReferenceMicros: 2809933 };
  const runs = Array.from({ length: 13 }, (_, i) => ({ id: syntheticId(i + 1),
    status: i === 12 ? 'failed' : 'succeeded', proposal_id: i < 3 ? syntheticId(100 + i) : null,
    interrupt_id: i < 3 ? `synthetic-interrupt-${i}` : null, decision: i < 3 ? true : null,
    trip_id: syntheticId(200 + i), owner_id: syntheticId(300 + i), current_version: i < 3 ? 2 : 1,
    snapshot: { label: `synthetic-trip-${i}`, requirements: { divers: i % 3 + 1 }, entries: [] as unknown[] } }));
  const callsPerRun = [3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1];
  const usage: CloudflareUsageEvidence[] = runs.map((run, i) => {
    const invocationCount = i < 3 ? 2 : 1;
    const calls: CloudflareUsageEvidence['calls'] = Array.from({ length: callsPerRun[i] }, (_, j) => ({ ...structuredClone(template.calls[0]),
      invocation_id: syntheticId(400 + i * 2 + (i < 3 && j === 2 ? 1 : 0)), run_id: run.id,
      call_id: `synthetic-${i}-${j}`, status: 'completed' as const,
      usage: i === 12 ? { promptTokens: 6654, outputTokens: 945, totalTokens: 7599 }
        : { promptTokens: 4500, outputTokens: 500, totalTokens: 5000 },
      provider_evidence: { provider: 'cloudflare' as const, returnedModel: CLOUDFLARE_MODEL,
        priceBasis: CLOUDFLARE_PRICE_BASIS } }));
    const invocations: CloudflareUsageEvidence['invocations'] = Array.from({ length: invocationCount }, (_, j) => {
      const id = syntheticId(400 + i * 2 + j);
      const cost = calls.filter(call => call.invocation_id === id).length * (i === 12 ? 949 : 600);
      return { ...structuredClone(template.invocations[0]), id, reservation_id: syntheticId(500 + i * 2 + j),
        run_id: run.id, logical_run_id: run.id, provider: 'cloudflare' as const, model: CLOUDFLARE_MODEL,
        reservation_status: 'settled' as const, status: 'settled' as const,
        kind: j === 0 ? 'start' as const : 'resume' as const,
        charged_cost_micros: String(cost), actual_cost_micros: String(cost) };
    });
    return { schemaVersion: 2, runId: run.id,
      binding: { ...template.binding, provider: 'cloudflare', model: CLOUDFLARE_MODEL }, invocations, calls };
  });
  const events: QualityEvent[] = runs.flatMap((run, i) => Array.from({ length: i === 12 ? 16 : 8 }, (_, j) => ({
    run_id: run.id, sequence: j + 1, event: j === 0 ? { type: 'RUN_STARTED', threadId: run.trip_id, runId: run.id }
      : { type: j === (i === 12 ? 15 : 7) ? (i === 12 ? 'RUN_ERROR' : 'RUN_FINISHED') : 'CUSTOM',
        name: 'synthetic-event', value: `${i}-${j}` },
  })));
  let cumulativeCost = 0;
  const records: (QualityAttempt | QualityAudit | Skip)[] = runs.flatMap((run, i) => {
    const round = i === 0 ? 0 : i <= 10 ? 1 : 2, caseId = `synthetic-case-${i}`;
    cumulativeCost += usage[i].invocations.reduce((sum, receipt) => sum + Number(receipt.actual_cost_micros), 0);
    const { id, status, proposal_id, interrupt_id, decision } = run;
    return [
      { kind: 'attempt' as const, round, caseId,
        evidence: { runId: id, afterVersion: run.current_version, after: structuredClone(run.snapshot) } },
      { kind: 'durable-audit' as const, round, caseId, runs: [{ id, status, proposal_id, interrupt_id, decision }],
        events: structuredClone(events.filter(event => event.run_id === id)), privateUsage: [structuredClone(usage[i])],
        chargedMicros: cumulativeCost, privateUsageComplete: true, quiescent: true },
    ];
  });
  records.push(...Array.from({ length: 18 }, (_, i) => ({ kind: 'skip' as const, round: i < 8 ? 2 : 3,
    caseId: `synthetic-skipped-${i}`, reason: 'FAILED_RUN_STOP' })));
  const report = { model: template.binding.model, accountId: template.binding.accountId, prior: structuredClone(prior),
    stopped: 'FAILED_RUN_STOP', textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    historicalUnknownReceipts: 1, dispatchAuthorized: false, invocations: 16, modelCalls: 24, chargedMicros: 14749,
    totalTokens: 122599, cumulativeInvocations: 26, cumulativeModelCalls: 38, cumulativeChargedMicros: 204816,
    cumulativeTokens: null, records };
  return { report, prior, snapshot: { counts: { runs: 13, trips: 13, invocations: 16, calls: 24, reservations: 16, proposals: 3 },
    runs, events, usage } };
}

export type QualityCarryFixture = ReturnType<typeof qualityCarryFixture>;
export const qualityAudits = (f: QualityCarryFixture) => f.report.records.filter((r): r is QualityAudit => r.kind === 'durable-audit');
export const qualityAttempts = (f: QualityCarryFixture) => f.report.records.filter((r): r is QualityAttempt => r.kind === 'attempt');
