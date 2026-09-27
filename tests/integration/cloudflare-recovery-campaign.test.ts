import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareRecoveryCampaign, type RecoveryCampaignReport } from '../../evals/cloudflare-recovery-campaign';
import { evaluationInput } from '../../evals/fixtures';
import { usageEvidenceSchema } from '../../evals/usage-evidence';
import { database } from '../../src/server/db';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { recoveryAccount, recoveryPrior } from '../support/cloudflare-recovery-fixture';
import { withDatabase } from '../support/database';

const placeholder = 'offline-placeholder-not-a-credential';
const first = ['unknown-cost', 'no-date'];
const slots = [...first.map(caseId => ({ round: 1, caseId })),
  ...[1, 2, 3].flatMap(round => cases.filter(c => round !== 1 || !first.includes(c.id))
    .map(c => ({ round, caseId: c.id })))];

function expectStopped(report: RecoveryCampaignReport, attempted: number, stopped: string) {
  expect(report).toMatchObject({ prior: recoveryPrior, maxModelCalls: 210, maxInvocations: 60, stopped,
    cumulativeTokens: null, historicalUnknownReceipts: 2, accountingComplete: false,
    dispatchAuthorized: false, textReview: 'pending', evaluationGatePassed: false });
  expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped'))
    .toEqual(slots.slice(attempted).map(slot => ({ ...slot, outcome: 'skipped', reason: stopped })));
  expect(report.cumulativeChargedMicros).toBe(recoveryPrior.chargedMicros + report.chargedMicros);
  expect(report.cumulativeInvocations).toBe(39 + report.invocations);
  expect(report.cumulativeModelCalls).toBe(56 + report.modelCalls);
  expect(JSON.stringify(report)).not.toContain(placeholder);
}

test('synthetic HTTP clarifications for both round-one cases are captured before review blocks the other 28',
  () => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    // The offline worker only accepts this synthetic transport account.
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
      priorChargedMicros: recoveryPrior.chargedMicros, offlineScenario: 'clarify', loadCredential });
    const execute = vi.fn(adapter.execute), capture = vi.fn(adapter.capture);
    const checkpoint = vi.fn<(report: RecoveryCampaignReport) => Promise<void>>(async () => {});
    const checkDispatch = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      expect(loadCredential).toHaveBeenCalledTimes(checkDispatch.mock.calls.length - 1);
    });
    const reviewPreflight = vi.fn(async (report: RecoveryCampaignReport) => {
      expect(execute.mock.calls.map(([id]) => id)).toEqual(first);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(report).toEqual(checkpoint.mock.calls.at(-1)?.[0]);
      expect(report.records.filter(row => (row as { kind?: string }).kind === 'durable-audit')).toHaveLength(2);
      return false;
    });
    const report = await runCloudflareRecoveryCampaign({ accountId: recoveryAccount, prior: recoveryPrior,
      execute, capture, checkpoint, checkDispatch, reviewPreflight, now: Date.now, pause: async () => {} });
    expect(reviewPreflight).toHaveBeenCalledTimes(1);
    expect(checkDispatch).toHaveBeenCalledTimes(2);
    expect(loadCredential).toHaveBeenCalledTimes(2);
    for (const [i, caseId] of first.entries()) {
      const result = await execute.mock.results[i].value;
      expect(result.evidence).toMatchObject({ caseId, terminal: 'clarification', runStatus: 'succeeded',
        beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 1, decision: 'none', proposalId: null,
        usageComplete: true, modelCalls: 1 });
      expect(result.evidence.after).toEqual(evaluationInput(caseId).before);
      expect(result.grade).toMatchObject({ pass: false, safetyFailures: [], reasons: ['TEXT_REVIEW_REQUIRED'] });
      expect(report.records).toContainEqual({ round: 1, caseId, outcome: 'completed', ...result });
      const captured = await capture.mock.results[i].value;
      expect(captured).toMatchObject({ usageKnown: true, privateUsageComplete: true, record: { quiescent: true } });
      const usage = usageEvidenceSchema.parse(captured.record.privateUsage[0]);
      expect(usage.invocations.map(row => row.kind)).toEqual(['start']);
      expect(usage.invocations.every(row => row.status === 'settled' && row.actual_cost_micros !== null)).toBe(true);
    }
    expect((await database().query('SELECT current_version FROM trips')).rows).toEqual([{ current_version: 1 }, { current_version: 1 }]);
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows[0].count).toBe(0);
    expect(report).toMatchObject({ invocations: 2, modelCalls: 2, totalTokens: 56 });
    expectStopped(report, 2, 'PREFLIGHT_TEXT_REVIEW_STOP');
  }), 45_000);

test.each(['invalid-tool-arguments', 'rate-limit'] as const)('synthetic HTTP %s in the first case skips the second and all later cases',
  scenario => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
      priorChargedMicros: recoveryPrior.chargedMicros, offlineScenario: scenario, loadCredential });
    const execute = vi.fn(adapter.execute), capture = vi.fn(adapter.capture);
    const checkDispatch = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const reviewPreflight = vi.fn(async () => true);
    const report = await runCloudflareRecoveryCampaign({ accountId: recoveryAccount, prior: recoveryPrior,
      execute, capture, checkDispatch, reviewPreflight, checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['unknown-cost']);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(reviewPreflight).not.toHaveBeenCalled();
    const result = await execute.mock.results[0].value;
    expect(result.evidence).toMatchObject({ runStatus: 'failed', beforeVersion: 1, afterVersion: 1, modelCalls: 1 });
    expect(result.evidence.after).toEqual(evaluationInput('unknown-cost').before);
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows[0].count).toBe(0);
    expect(report).toMatchObject({ invocations: 1, modelCalls: 1,
      totalTokens: scenario === 'rate-limit' ? null : 28,
      chargedMicros: scenario === 'rate-limit' ? maximumProviderModelCost('cloudflare') : 5 });
    expectStopped(report, 1, scenario === 'rate-limit' ? 'UNKNOWN_USAGE_STOP' : 'FAILED_RUN_STOP');
  }), 45_000);

test('denied dispatch reaches neither synthetic credential loader nor model accounting', () => withDatabase(async () => {
  const loadCredential = vi.fn(async () => placeholder);
  const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32),
    priorChargedMicros: recoveryPrior.chargedMicros, offlineScenario: 'clarify', loadCredential });
  const execute = vi.fn(adapter.execute), capture = vi.fn(adapter.capture);
  const checkDispatch = vi.fn(async () => { throw new Error('EVAL_HISTORY_CHANGED'); });
  const reviewPreflight = vi.fn(async () => true);
  const checkpoint = vi.fn<(report: RecoveryCampaignReport) => Promise<void>>(async () => {});
  // With no admitted run, real capture cannot establish quiescence; retain both stop observations.
  await expect(runCloudflareRecoveryCampaign({ accountId: recoveryAccount, prior: recoveryPrior,
    execute, capture, checkDispatch, reviewPreflight, checkpoint, now: Date.now, pause: async () => {} }))
    .rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(execute.mock.calls.map(([id]) => id)).toEqual(['unknown-cost']);
  expect(checkDispatch).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(loadCredential).not.toHaveBeenCalled();
  expect(reviewPreflight).not.toHaveBeenCalled();
  expect(checkpoint.mock.calls.some(([r]) => r.stopped === 'EVAL_HISTORY_CHANGED')).toBe(true);
  expect(checkpoint.mock.calls.at(-1)?.[0]).toMatchObject({ stopped: 'EVIDENCE_EXPORT_STOP', invocations: 0,
    modelCalls: 0, chargedMicros: 0, cumulativeInvocations: 39, cumulativeModelCalls: 56,
    cumulativeChargedMicros: 396708, cumulativeTokens: null });
  const counts = await database().query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
    (SELECT count(*)::int FROM agent_invocations) AS invocations,
    (SELECT count(*)::int FROM quota_reservations) AS reservations,
    (SELECT count(*)::int FROM model_calls) AS calls`);
  expect(counts.rows).toEqual([{ runs: 0, invocations: 0, reservations: 0, calls: 0 }]);
}), 30_000);
