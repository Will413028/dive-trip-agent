import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareRevisionCampaign, type RevisionCampaignReport } from '../../evals/cloudflare-revision-campaign';
import type { RecordedEvaluationV2 } from '../../evals/collector';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidenceV2 as gradeEvidence, type RunEvidenceV2 as RunEvidence } from '../../evals/evidence';
import type { CampaignCapture } from '../../evals/cloudflare-campaign';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

type Result = RecordedEvaluationV2;
type Ports = Parameters<typeof runCloudflareRevisionCampaign>[0];
const baseline: Ports["prior"] = { sourceSha256: "bdd12aea5bff6267a47b09ca0f3bd889faa442cc5cb8e703198ff5e16b709713", historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 1, invocations: 26, modelCalls: 38, chargedMicros: 204816, observedTokens: 183791, totalTokens: null, remainingInvocationCeiling: 74, remainingReferenceMicros: 2795184 };

function resultFor(caseId: string, patch: Partial<RunEvidence> = {}, attempt = 1): Result {
  const input = evaluationInput(caseId);
  const proposal = input.terminal === 'proposal';
  const runId = `synthetic-${caseId}-${attempt}`;
  const after = structuredClone(input.before);
  if (caseId === 'free-afternoon') after.entries = after.entries.filter(entry => entry.id !== 'transfer');
  if (caseId === 'non-diver') after.requirements.divers = 0;
  if (caseId === 'more-people') { after.requirements.people = 3; after.entries[0].rooms = 2; }
  const evidence: RunEvidence = {
    caseId, inputDigest: input.digest, runId, before: input.before,
    beforeDecision: structuredClone(input.before), after, beforeVersion: 1, beforeDecisionVersion: 1,
    afterVersion: proposal ? 2 : 1, terminal: input.terminal as RunEvidence['terminal'], runStatus: 'succeeded',
    decision: proposal ? 'accept' : 'none', proposalId: proposal ? 'synthetic-proposal' : null,
    decisionRunId: proposal ? runId : null, decisionProposalId: proposal ? 'synthetic-proposal' : null,
    model: CLOUDFLARE_MODEL, usageRunId: runId, usageComplete: true,
    modelCalls: 2, toolCount: 2, visibleToolCount: 1, costMicros: 100, latencyMs: 1000, textReview: 'pending',
    faultObserved: input.fault, ...patch,
  };
  return { schemaVersion: 2, evidence, events: [], grade: gradeEvidence(evidence, CLOUDFLARE_MODEL) };
}

function harness(options: {
  prior?: Ports["prior"];
  dispatches?: number;
  workMs?: number;
  result?: (caseId: string, attempt: number) => Result;
  capture?: (attempt: number) => CampaignCapture;
} = {}) {
  let time = 100_000;
  let attempts = 0;
  const checkpoints: RevisionCampaignReport[] = [];
  const dispatchTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const trace: string[] = [];
  const ports = {
    reviewPreflight: vi.fn(async () => true),
    checkDispatch: vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); }),
    accountId: '1fd574e905257afa3cfd7db80cf70b23', prior: { ...(options.prior ?? baseline) },
    now: () => time,
    pause: vi.fn(async (ms: number, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      time += ms;
    }),
    checkpoint: vi.fn(async (report: RevisionCampaignReport) => {
      // Keep the supplied object: later mutation would expose a missing snapshot boundary.
      checkpoints.push(report);
      await Promise.resolve();
      trace.push(`saved:${report.invocations}`);
    }),
    execute: vi.fn(async (caseId: string, beforeDispatch: Parameters<Ports['execute']>[1]) => {
      expect(checkpoints.length).toBeGreaterThan(0);
      const attempt = ++attempts;
      const count = options.dispatches ?? (evaluationInput(caseId).terminal === 'proposal' ? 2 : 1);
      const signal = new AbortController().signal;
      signals.push(signal);
      for (let i = 0; i < count; i++) {
        await beforeDispatch(signal);
        expect(trace.at(-1)).toBe(`saved:${dispatchTimes.length + 1}`);
        expect(checkpoints.at(-1)?.invocations).toBe(dispatchTimes.length + 1);
        dispatchTimes.push(time);
        trace.push('dispatch');
        time += options.workMs ?? 4000;
      }
      return options.result?.(caseId, attempt) ?? resultFor(caseId, {}, attempt);
    }),
    capture: vi.fn(async (): Promise<CampaignCapture> => options.capture?.(attempts) ?? {
      chargedMicros: attempts * 100, modelCalls: attempts * 2, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true },
    }),
  } satisfies Ports;
  return { ports, checkpoints, dispatchTimes, signals, trace };
}

test('preflight capture and review precede exactly 30 slots; all accounting stays cumulative', async () => {
  const h = harness();
  h.ports.reviewPreflight.mockImplementation(async () => {
    expect(h.ports.execute).toHaveBeenCalledTimes(1);
    expect(h.ports.capture).toHaveBeenCalledTimes(1);
    expect(h.checkpoints.at(-1)).toMatchObject({ invocations: 2, modelCalls: 2, totalTokens: 1000 });
    return true;
  });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual(['non-diver', ...[1, 2, 3].flatMap(() => cases.map(c => c.id))]);
  expect(h.ports.reviewPreflight).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(31);
  expect(h.ports.checkDispatch).toHaveBeenCalledTimes(41);
  expect(h.checkpoints.every(saved => saved.schemaVersion === 2)).toBe(true);
  expect(r).toMatchObject({ schemaVersion: 2, stopped: null, maxModelCalls: 217, maxInvocations: 62,
    modelCalls: 62, invocations: 41, chargedMicros: 3100, totalTokens: 31000,
    cumulativeModelCalls: 100, cumulativeInvocations: 67, cumulativeChargedMicros: 207916,
    cumulativeTokens: null, accountingComplete: false, evaluationGatePassed: false });
  expect(h.dispatchTimes.slice(1).every((time, i) => time - h.dispatchTimes[i] >= 15000)).toBe(true);
});
test('permits 217 total new calls, never resets preflight usage before the batch', async () => {
  const h = harness({ result: (id, n) => resultFor(id, { modelCalls: 7 }, n), capture: n => ({
    chargedMicros: n * 100, modelCalls: n * 7, totalTokens: n * 1000,
    usageKnown: true, privateUsageComplete: true, record: {},
  }) });
  expect(await runCloudflareRevisionCampaign(h.ports)).toMatchObject({ stopped: null, modelCalls: 217, cumulativeModelCalls: 255 });
});
test.each(['failed', 'unknown'] as const)('technical preflight %s skips prose review and all 30 slots', async mode => {
  const h = harness({ result: (id, n) => resultFor(id, mode === 'failed' ? { runStatus: 'failed' } : { usageComplete: false }, n) });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(r.stopped).toBe(mode === 'failed' ? 'FAILED_RUN_STOP' : 'UNKNOWN_USAGE_STOP');
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(r.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(30);
});
test.each(['negative', 'throws'] as const)('preflight review %s stops without retry', async mode => {
  const h = harness();
  h.ports.reviewPreflight.mockImplementation(async () => { if (mode === 'throws') throw new Error('private'); return false; });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(r.stopped).toBe('PREFLIGHT_TEXT_REVIEW_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(r)).not.toContain('private');
});
test('failure after a passed preflight stops all later rounds and captures its usage', async () => {
  const h = harness({ result: (id, n) => resultFor(id, n === 3 ? { runStatus: 'failed' } : {}, n) });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(r).toMatchObject({ stopped: 'FAILED_RUN_STOP', modelCalls: 6, cumulativeModelCalls: 44 });
  expect(h.ports.execute).toHaveBeenCalledTimes(3);
});
test.each(Object.keys(baseline))('changed historical field %s rejects before any dispatch', async key => {
  const h = harness(); Object.assign(h.ports.prior, { [key]: 'invalid' });
  await expect(runCloudflareRevisionCampaign(h.ports)).rejects.toThrow();
  expect(h.ports.execute).not.toHaveBeenCalled();
});

test('preflight goal miss keeps evidence but never requests prose approval', async () => {
  const h = harness({ result: (id, n) => resultFor(id, { after: evaluationInput(id).before }, n) });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(r.stopped).toBe('PREFLIGHT_GOAL_STOP');
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(r.records[0]).toHaveProperty('evidence');
  expect(r.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(30);
});
test('rechecks history before every start/resume; a denied gate cannot dispatch', async () => {
  const h = harness();
  h.ports.checkDispatch.mockRejectedValueOnce(new Error('EVAL_HISTORY_CHANGED'));
  h.ports.capture.mockImplementation(async () => ({
    chargedMicros: 0, modelCalls: 0, totalTokens: 0, privateUsageComplete: true, usageKnown: true, record: {},
  }));
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(h.dispatchTimes).toEqual([]);
  expect(r).toMatchObject({ stopped: 'EVAL_HISTORY_CHANGED', invocations: 0, modelCalls: 0 });
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
});
test.each(['checkDispatch', 'reviewPreflight'] as const)('missing %s is rejected before any IO', async key => {
  const h = harness(); Object.assign(h.ports, { [key]: undefined });
  await expect(runCloudflareRevisionCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
  expect(h.ports.execute).not.toHaveBeenCalled();
});
test('duplicate preflight run cannot masquerade as a fresh round-one run', async () => {
  const h = harness({ result: (id, n) => resultFor(id, { runId: 'reused', usageRunId: 'reused',
    decisionRunId: evaluationInput(id).terminal === 'proposal' ? 'reused' : null }, n) });
  const r = await runCloudflareRevisionCampaign(h.ports);
  expect(r.stopped).toBe('EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(2);
});
test('wrong account is rejected before checkpoint or execution', async () => {
  const h = harness(); h.ports.accountId = 'a'.repeat(32);
  await expect(runCloudflareRevisionCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
  expect(h.ports.execute).not.toHaveBeenCalled();
});
