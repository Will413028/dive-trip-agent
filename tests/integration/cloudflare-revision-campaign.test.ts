import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareRevisionCampaign, type RevisionCampaignReport } from '../../evals/cloudflare-revision-campaign';
import { evaluationInput } from '../../evals/fixtures';
import { usageEvidenceSchema } from '../../evals/usage-evidence';
import { database } from '../../src/server/db';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';

// Synthetic projection of the pinned latest-quality history, not live admission.
const prior = {
  sourceSha256: 'bdd12aea5bff6267a47b09ca0f3bd889faa442cc5cb8e703198ff5e16b709713',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 26, modelCalls: 38, chargedMicros: 204816,
  observedTokens: 183791, totalTokens: null, remainingInvocationCeiling: 74, remainingReferenceMicros: 2795184,
} as const;
const accountId = '1fd574e905257afa3cfd7db80cf70b23';
const placeholder = 'offline-placeholder-not-a-credential';

function expectStoppedBatch(report: RevisionCampaignReport, stopped: string) {
  expect(report).toMatchObject({ prior, maxModelCalls: 217, maxInvocations: 62, stopped,
    cumulativeTokens: null, historicalUnknownReceipts: 1, accountingComplete: false,
    dispatchAuthorized: false, textReview: 'pending', evaluationGatePassed: false });
  expect(report.records.filter(record => record && typeof record === 'object' && 'outcome' in record
    && record.outcome === 'skipped')).toEqual([1, 2, 3].flatMap(round => cases.map(spec => ({
    round, caseId: spec.id, outcome: 'skipped', reason: stopped,
  }))));
  expect(report.cumulativeChargedMicros).toBe(prior.chargedMicros + report.chargedMicros);
  expect(report.cumulativeInvocations).toBe(prior.invocations + report.invocations);
  expect(report.cumulativeModelCalls).toBe(prior.modelCalls + report.modelCalls);
  expect(JSON.stringify(report)).not.toContain(placeholder);
}

test('revision preflight completes native confirmation but stops a non-diver goal miss before review',
  () => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    // The existing fetch-only bootstrap accepts only this synthetic account.
    // Scheduler identity and the synthetic transport binding are separate.
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
      priorChargedMicros: prior.chargedMicros, offlineScenario: 'proposal', loadCredential });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    const checkDispatch = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      expect(loadCredential).toHaveBeenCalledTimes(checkDispatch.mock.calls.length - 1);
    });
    const reviewPreflight = vi.fn(async () => true);
    const checkpoint = vi.fn<(report: RevisionCampaignReport) => Promise<void>>(async () => {});
    const report = await runCloudflareRevisionCampaign({ accountId, prior, execute, capture,
      reviewPreflight, checkDispatch, checkpoint, now: Date.now, pause: async () => {} });

    expect(execute.mock.calls.map(([id]) => id)).toEqual(['non-diver']);
    expect(checkDispatch).toHaveBeenCalledTimes(2);
    expect(loadCredential).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(reviewPreflight).not.toHaveBeenCalled();
    const result = await execute.mock.results[0].value;
    expect(result.evidence).toMatchObject({ beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 2,
      decision: 'accept', terminal: 'proposal', runStatus: 'succeeded', usageComplete: true, modelCalls: 2 });
    expect(result.evidence.beforeDecision).toEqual(evaluationInput('non-diver').before);
    expect(result.evidence.decisionRunId).toBe(result.evidence.runId);
    expect(result.evidence.decisionProposalId).toBe(result.evidence.proposalId);
    expect(result.grade).toMatchObject({ pass: false, safetyFailures: [],
      reasons: expect.arrayContaining(['GOAL_MISSED', 'TEXT_REVIEW_REQUIRED']) });
    expect(report.records).toContainEqual({ round: 0, caseId: 'non-diver', outcome: 'completed', ...result });
    const versions = await database().query('SELECT version,snapshot FROM trip_versions ORDER BY version');
    expect(versions.rows.map(row => row.version)).toEqual([1, 2]);
    const before = evaluationInput('non-diver').before;
    expect(versions.rows[0].snapshot).toEqual(before);
    expect(versions.rows[1].snapshot.requirements.divers).toBe(before.requirements.divers);
    expect(versions.rows[1].snapshot.requirements.pace).not.toBe(before.requirements.pace);
    expect(versions.rows[1].snapshot).toEqual(result.evidence.after);
    const captured = await capture.mock.results[0].value;
    expect(captured).toMatchObject({ privateUsageComplete: true, usageKnown: true, modelCalls: 2,
      totalTokens: 56, record: { quiescent: true } });
    expect(report.records).toContainEqual({ ...captured.record, kind: 'durable-audit', round: 0, caseId: 'non-diver' });
    const usage = usageEvidenceSchema.parse(captured.record.privateUsage[0]);
    expect(usage.invocations.map(row => row.kind)).toEqual(['start', 'resume']);
    expect(usage.invocations.every(row => row.status === 'settled' && row.actual_cost_micros !== null)).toBe(true);
    expect(report).toMatchObject({ invocations: 2, modelCalls: 2, totalTokens: 56 });
    expectStoppedBatch(report, 'PREFLIGHT_GOAL_STOP');
    expect(checkpoint.mock.calls.at(-1)?.[0]).toEqual(report);
  }, { retainOnFailure: false }), 45_000);

test.each(['invalid-tool-arguments', 'rate-limit'] as const)(
  'revision preflight stops synthetic %s without review, retry or later dispatch', scenario => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
      priorChargedMicros: prior.chargedMicros, offlineScenario: scenario, loadCredential });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    const checkDispatch = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const reviewPreflight = vi.fn(async () => true);
    const report = await runCloudflareRevisionCampaign({ accountId, prior, execute, capture,
      reviewPreflight, checkDispatch, checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['non-diver']);
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(reviewPreflight).not.toHaveBeenCalled();
    const result = await execute.mock.results[0].value;
    expect(result.evidence).toMatchObject({ runStatus: 'failed', decision: 'none', proposalId: null,
      beforeVersion: 1, afterVersion: 1, modelCalls: 1 });
    expect(result.evidence.after).toEqual(evaluationInput('non-diver').before);
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows[0].count).toBe(0);
    expect((await database().query('SELECT current_version FROM trips')).rows[0].current_version).toBe(1);
    expect((await database().query('SELECT snapshot FROM trip_versions')).rows[0].snapshot)
      .toEqual(evaluationInput('non-diver').before);
    expect(report).toMatchObject({ invocations: 1, modelCalls: 1,
      totalTokens: scenario === 'rate-limit' ? null : 28,
      chargedMicros: scenario === 'rate-limit' ? maximumProviderModelCost('cloudflare') : 5 });
    expectStoppedBatch(report, scenario === 'rate-limit' ? 'UNKNOWN_USAGE_STOP' : 'FAILED_RUN_STOP');
    expect(report.records).toContainEqual(expect.objectContaining({ kind: 'durable-audit',
      privateUsageComplete: true, quiescent: true }));
  }, { retainOnFailure: false }), 45_000);

test('revision denied dispatch never loads the placeholder or creates model accounting, even when capture fails',
  () => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
      priorChargedMicros: prior.chargedMicros, offlineScenario: 'proposal', loadCredential });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    const checkDispatch = vi.fn(async () => { throw new Error('EVAL_HISTORY_CHANGED'); });
    const reviewPreflight = vi.fn(async () => true);
    const checkpoint = vi.fn<(report: RevisionCampaignReport) => Promise<void>>(async () => {});
    // With no run, real capture cannot prove quiescence and the scheduler throws.
    // This synthetic test deliberately disables live forensic schema retention.
    await expect(runCloudflareRevisionCampaign({ accountId, prior, execute, capture, checkDispatch,
      reviewPreflight, checkpoint, now: Date.now, pause: async () => {} }))
      .rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['non-diver']);
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(loadCredential).not.toHaveBeenCalled();
    expect(reviewPreflight).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
    const counts = await database().query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
      (SELECT count(*)::int FROM agent_invocations) AS invocations,
      (SELECT count(*)::int FROM quota_reservations) AS reservations,
      (SELECT count(*)::int FROM model_calls) AS calls`);
    expect(counts.rows).toEqual([{ runs: 0, invocations: 0, reservations: 0, calls: 0 }]);
    expect(checkpoint.mock.calls.some(([report]) => report.stopped === 'EVAL_HISTORY_CHANGED')).toBe(true);
    expect(checkpoint.mock.calls.at(-1)?.[0]).toMatchObject({ stopped: 'EVIDENCE_EXPORT_STOP',
      invocations: 0, modelCalls: 0, chargedMicros: 0, cumulativeInvocations: 26,
      cumulativeModelCalls: 38, cumulativeChargedMicros: 204816, cumulativeTokens: null });
  }, { retainOnFailure: false }), 30_000);
