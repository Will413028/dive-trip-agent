import { expect, test, vi } from 'vitest';
import { evaluationInput } from '../../evals/fixtures';
import { usageEvidenceSchema } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { database } from '../../src/server/db';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';

const accountId = 'a'.repeat(32);
const placeholder = 'offline-placeholder-not-a-credential';
const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId };

test('a denied dispatch gate cannot load a credential or create model accounting', () => withDatabase(async () => {
  const loadCredential = vi.fn(async () => placeholder);
  const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: 188267,
    loadCredential, offlineScenario: 'proposal' });
  await expect(ports.execute('free-afternoon', async () => { throw new Error('EVAL_HISTORY_CHANGED'); }))
    .rejects.toThrow('EVAL_HISTORY_CHANGED');
  expect(loadCredential).not.toHaveBeenCalled();
  const counts = await database().query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
    (SELECT count(*)::int FROM agent_invocations) AS invocations, (SELECT count(*)::int FROM model_calls) AS calls`);
  expect(counts.rows).toEqual([{ runs: 0, invocations: 0, calls: 0 }]);
}));

test('campaign ports construction is lazy, including the default live context', () => {
  const loadCredential = vi.fn(async () => placeholder);
  const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: 188_267, loadCredential });
  expect(Object.keys(ports).sort()).toEqual(['capture', 'execute']);
  expect(loadCredential).not.toHaveBeenCalled();
});

// Uses the existing synthetic-fetch bootstrap, which imports the real worker:
// HTTP -> admission -> native ADK/Postgres -> IPC -> HTTP -> private capture.
// No mocks of the collector, runtime, accounting or drain; no live opt-in.
test('campaign ports collect free-afternoon through native confirmation and capture cumulative evidence',
  () => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: 188_267,
      loadCredential, offlineScenario: 'proposal' });
    let previousRunId: string | undefined;
    let previousCharge = 0;
    for (const iteration of [1, 2]) {
      const beforeDispatch = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        // Both phases pass the caller's gate; only start loads a credential.
        expect(loadCredential).toHaveBeenCalledTimes(iteration - 1 + beforeDispatch.mock.calls.length - 1);
      });
      const result = await ports.execute('free-afternoon', beforeDispatch);
      expect(beforeDispatch).toHaveBeenCalledTimes(2);
      expect(loadCredential).toHaveBeenCalledTimes(iteration);
      expect(result.evidence).toMatchObject({ beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 2,
        decision: 'accept', runStatus: 'succeeded', usageComplete: true, modelCalls: 2,
        model: CLOUDFLARE_MODEL, textReview: 'pending' });
      expect(result.evidence.beforeDecision).toEqual(evaluationInput('free-afternoon').before);
      expect(result.evidence.decisionRunId).toBe(result.evidence.runId);
      expect(result.evidence.decisionProposalId).toBe(result.evidence.proposalId);
      expect(result.evidence.runId).not.toBe(previousRunId);
      // The fixed fake proposal changes pace, not the requested afternoon.
      expect(result.grade.pass).toBe(false);
      expect(result.grade.reasons).toEqual(expect.arrayContaining(['GOAL_MISSED', 'TEXT_REVIEW_REQUIRED']));

      const captured = await ports.capture();
      expect(captured).toMatchObject({ modelCalls: iteration * 2, totalTokens: iteration * 56,
        usageKnown: true, privateUsageComplete: true,
        record: { quiescent: true, privateUsageComplete: true, runs: [
          { id: result.evidence.runId, status: 'succeeded', decision: true, proposal_id: result.evidence.proposalId },
        ] } });
      expect(captured.chargedMicros).toBe(previousCharge + result.evidence.costMicros!);
      expect(captured.record.chargedMicros).toBe(captured.chargedMicros);
      expect(captured.record.privateUsage).toHaveLength(1);
      const evidence = usageEvidenceSchema.parse(captured.record.privateUsage[0]);
      expect(evidence).toMatchObject({ schemaVersion: 2, binding, runId: result.evidence.runId });
      expect(evidence.invocations.map(row => row.kind)).toEqual(['start', 'resume']);
      expect(evidence.invocations.every(row => row.status === 'settled' && row.actual_cost_micros !== null)).toBe(true);
      expect(evidence.calls).toHaveLength(2);
      const resume = evidence.invocations.find(row => row.kind === 'resume')!;
      expect(resume).toMatchObject({ actual_cost_micros: '0', charged_cost_micros: '0' });
      expect(evidence.calls.filter(call => call.invocation_id === resume.id)).toEqual([]);
      expect(evidence.calls.every(call => call.status === 'completed' && call.usage?.totalTokens === 28)).toBe(true);
      expect(captured.record.events.map(row => row.event)).toEqual(result.events);
      const proposals = await database().query('SELECT catalog_snapshot FROM proposals WHERE id=$1', [result.evidence.proposalId]);
      expect(proposals.rows[0].catalog_snapshot).toEqual(evaluationInput('free-afternoon').catalog);
      expect(JSON.stringify(result.events)).not.toMatch(/promptTokens|priceBasis|returnedModel|hashingKey/);
      expect(JSON.stringify(result.events)).not.toContain(accountId);
      expect(JSON.stringify(captured)).not.toContain(placeholder);
      previousRunId = result.evidence.runId;
      previousCharge = captured.chargedMicros;
    }
  }), 90_000);

test.each(['missing-usage', 'rate-limit'] as const)('campaign ports capture %s without losing unknown usage',
  scenario => withDatabase(async () => {
    const loadCredential = vi.fn(async () => placeholder);
    const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: 188_267,
      loadCredential, offlineScenario: scenario });
    const beforeDispatch = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const result = await ports.execute('free-afternoon', beforeDispatch);
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(result.evidence).toMatchObject({ runStatus: 'failed', decision: 'none', afterVersion: 1,
      usageComplete: false, costMicros: null, modelCalls: 1, proposalId: null });
    expect(result.evidence.after).toEqual(result.evidence.before);
    const captured = await ports.capture();
    expect(captured).toMatchObject({ chargedMicros: maximumProviderModelCost('cloudflare'), modelCalls: 1,
      totalTokens: null, usageKnown: false, privateUsageComplete: true,
      record: { quiescent: true, privateUsageComplete: true,
        runs: [{ id: result.evidence.runId, status: 'failed', proposal_id: null }] } });
    expect(captured.record.privateUsage).toHaveLength(1);
    const evidence = usageEvidenceSchema.parse(captured.record.privateUsage[0]);
    expect(evidence).toMatchObject({ schemaVersion: 2, binding, runId: result.evidence.runId,
      invocations: [{ kind: 'start', status: 'settled', actual_cost_micros: null,
        charged_cost_micros: String(maximumProviderModelCost('cloudflare')) }], calls: [{ usage: null }] });
    expect(evidence.calls).toHaveLength(1);
    expect(captured.record.events.map(row => row.event)).toEqual(result.events);
    expect(result.events.at(-1)?.type).toBe('RUN_ERROR');
    expect(JSON.stringify(captured)).not.toContain(placeholder);
  }), 30_000);
