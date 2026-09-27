import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareCampaign, type CampaignBaseline, type CampaignCapture, type CloudflareCampaignReport } from '../../evals/cloudflare-campaign';
import type { RecordedEvaluationV2 } from '../../evals/collector';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidenceV2 as gradeEvidence, type RunEvidenceV2 as RunEvidence } from '../../evals/evidence';
import { CAMPAIGN_BUDGET_MICROS } from '../../evals/campaign-policy';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { maximumProviderModelCost } from '../../src/server/model-cost';

type Result = RecordedEvaluationV2;
type Ports = Parameters<typeof runCloudflareCampaign>[0];
const baseline: CampaignBaseline = { chargedMicros: 3976, invocations: 6, modelCalls: 9, totalTokens: 36403 };
const reservation = maximumProviderModelCost('cloudflare');

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
  prior?: CampaignBaseline;
  dispatches?: number;
  workMs?: number;
  result?: (caseId: string, attempt: number) => Result;
  capture?: (attempt: number) => CampaignCapture;
} = {}) {
  let time = 100_000;
  let attempts = 0;
  const checkpoints: CloudflareCampaignReport[] = [];
  const dispatchTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const trace: string[] = [];
  const ports = {
    accountId: 'a'.repeat(32), prior: { ...(options.prior ?? baseline) },
    now: () => time,
    pause: vi.fn(async (ms: number, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      time += ms;
    }),
    checkpoint: vi.fn(async (report: CloudflareCampaignReport) => {
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

function slots(report: CloudflareCampaignReport) {
  return report.records.filter((record): record is Record<string, unknown> =>
    !!record && typeof record === 'object' && 'outcome' in record);
}

function expectStopped(report: CloudflareCampaignReport, reason: string, attempted = 1) {
  expect(report.stopped).toBe(reason);
  const records = slots(report);
  expect(records).toHaveLength(30);
  expect(records.slice(attempted)).toEqual([1, 2, 3].flatMap(round => cases.map(spec => ({
    round, caseId: spec.id, outcome: 'skipped', reason,
  }))).slice(attempted));
}

test('runs exactly 3 x 10 ordered slots, checkpoints every dispatch, spaces start/resume and carries usage', async () => {
  const h = harness();
  const report = await runCloudflareCampaign(h.ports);
  expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual([1, 2, 3].flatMap(() => cases.map(c => c.id)));
  expect(slots(report).map(({ round, caseId, outcome }) => ({ round, caseId, outcome }))).toEqual(
    [1, 2, 3].flatMap(round => cases.map(c => ({ round, caseId: c.id, outcome: 'completed' }))));
  expect(h.dispatchTimes).toHaveLength(39);
  expect(h.dispatchTimes[0]).toBe(115_000);
  expect(h.dispatchTimes.slice(1).map((time, i) => time - h.dispatchTimes[i])).toEqual(Array(38).fill(15_000));
  expect(h.ports.pause.mock.calls.map(([ms]) => ms)).toEqual([15_000, ...Array(38).fill(11_000)]);
  expect(h.ports.pause.mock.calls.map(([, signal]) => signal)).toEqual(h.signals.flatMap((signal, i) =>
    Array(evaluationInput(cases[i % 10].id).terminal === 'proposal' ? 2 : 1).fill(signal)));
  expect(h.ports.capture).toHaveBeenCalledTimes(30);
  expect(h.checkpoints[0]).toMatchObject({ schemaVersion: 2, invocations: 0, records: [], stopped: null });
  expect(h.checkpoints.every(saved => saved.schemaVersion === 2)).toBe(true);
  expect(h.checkpoints.at(-1)).toEqual(report);
  expect(h.checkpoints).toHaveLength(1 + 39 + 30 * 2 + 1);
  expect(report).toMatchObject({ schemaVersion: 2, prior: baseline, stopped: null, invocations: 39, chargedMicros: 3000,
    modelCalls: 60, totalTokens: 30_000, cumulativeChargedMicros: 6976, cumulativeInvocations: 45,
    cumulativeModelCalls: 69, cumulativeTokens: 66403, textReview: 'pending', evaluationGatePassed: false });
  expect(report.records.filter(record => (record as { kind?: string }).kind === 'durable-audit')).toHaveLength(30);
  for (const record of slots(report)) {
    expect(record.grade).toEqual({ pass: false, reasons: ['TEXT_REVIEW_REQUIRED'], safetyFailures: [] });
  }
});

test('does not add spacing once elapsed work already exceeds 15 seconds', async () => {
  const h = harness({ workMs: 20_000 });
  await runCloudflareCampaign(h.ports);
  expect(h.ports.pause.mock.calls.map(([ms]) => ms)).toEqual([15_000, ...Array(38).fill(0)]);
  expect(h.dispatchTimes.slice(1).every((time, i) => time - h.dispatchTimes[i] >= 15_000)).toBe(true);
});

test('accepts structurally compatible baseline metadata without including it in arithmetic or projected prior', async () => {
  const prior = { ...baseline, history: [{ name: 'synthetic-history.json', sha256: 'b'.repeat(64) }],
    metadata: { source: 'synthetic', cumulativeChargedMicros: 999_999 }, note: 'not a numeric counter' };
  const original = structuredClone(prior);
  // No cast: a history-loader result with extra properties is a valid baseline.
  const h = harness({ prior });
  expect(h.ports.prior).toHaveProperty('history', prior.history);
  const report = await runCloudflareCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, prior: baseline, chargedMicros: 3000, invocations: 39,
    modelCalls: 60, totalTokens: 30_000, cumulativeChargedMicros: 6976, cumulativeInvocations: 45,
    cumulativeModelCalls: 69, cumulativeTokens: 66403 });
  expect(report.prior).toEqual(baseline);
  expect(h.checkpoints.every(checkpoint => Object.keys(checkpoint.prior).length === 4)).toBe(true);
  expect(prior).toEqual(original);
});

test('the first failed case stops subsequent execution and captures that failure before final skipped slots', async () => {
  const h = harness({ result: (id, attempt) => resultFor(id, attempt === 4 ? { runStatus: 'failed' } : {}, attempt) });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'FAILED_RUN_STOP', 4);
  expect(h.ports.execute).toHaveBeenCalledTimes(4);
  expect(h.ports.capture).toHaveBeenCalledTimes(4);
  expect(slots(report)[3]).toMatchObject({ outcome: 'failed' });
  expect(report.chargedMicros).toBe(400);
});

test.each([new Error('synthetic-secret https://private.invalid/detail'), 'synthetic-secret'])('does not echo arbitrary execution exceptions: %s', async failure => {
  const h = harness({ result: () => { throw failure; } });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'EVAL_EXCEPTION_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.checkpoints)).not.toContain('synthetic-secret');
  expect(slots(report)[0]).toEqual({ round: 1, caseId: cases[0].id, outcome: 'failed', reason: 'EVAL_EXCEPTION_STOP', costMicros: null });
});

test('preserves a bounded rate-limit code without retrying', async () => {
  const h = harness({ result: () => { throw new Error('EVAL_RATE_LIMIT'); } });
  expectStopped(await runCloudflareCampaign(h.ports), 'EVAL_RATE_LIMIT');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test.each([undefined, 1, 3])('new reports cannot accept collected record version %s', async schemaVersion => {
  const h = harness({ result: (id, attempt) => {
    const result = resultFor(id, {}, attempt);
    if (schemaVersion === undefined) Reflect.deleteProperty(result, 'schemaVersion');
    else Object.assign(result, { schemaVersion });
    return result;
  } });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'EVAL_EVIDENCE_STOP');
  expect(report.schemaVersion).toBe(2);
  expect(slots(report)[0]).not.toHaveProperty('evidence');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test.each([
  [{ usageComplete: false }, 'UNKNOWN_USAGE_STOP'],
  [{ costMicros: null }, 'UNKNOWN_USAGE_STOP'],
  [{ textReview: 'failed' }, 'SAFETY_EVIDENCE_STOP'],
  [{ model: 'other-model' }, 'BINDING_OR_LIMIT_STOP'],
  [{ modelCalls: 0 }, 'BINDING_OR_LIMIT_STOP'],
  [{ latencyMs: 60_000 }, 'DEADLINE_STOP'],
] satisfies [Partial<RunEvidence>, string][])('stops on evidence %j', async (patch, reason) => {
  const h = harness({ result: id => resultFor(id, patch), capture: () => ({
    chargedMicros: 100, modelCalls: 'modelCalls' in patch ? patch.modelCalls : 2, totalTokens: 1000,
    privateUsageComplete: true, usageKnown: true, record: { synthetic: true },
  }) });
  expectStopped(await runCloudflareCampaign(h.ports), reason);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
});

test('unknown durable usage retains charged cost and null token totals', async () => {
  const h = harness({ capture: () => ({ chargedMicros: reservation, modelCalls: 2, totalTokens: null,
    privateUsageComplete: true, usageKnown: false, record: { synthetic: true } }) });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'UNKNOWN_USAGE_STOP');
  expect(report).toMatchObject({ chargedMicros: reservation, cumulativeChargedMicros: baseline.chargedMicros + reservation,
    totalTokens: null, cumulativeTokens: null });
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('carries prior budget at the exact reservation boundary and stops before the next case', async () => {
  const prior = { ...baseline, chargedMicros: CAMPAIGN_BUDGET_MICROS - reservation };
  const h = harness({ prior });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'BUDGET_STOP');
  expect(report.chargedMicros).toBe(100);
  expect(report.cumulativeChargedMicros).toBe(prior.chargedMicros + 100);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(prior.chargedMicros).toBe(CAMPAIGN_BUDGET_MICROS - reservation);
});

test.each([
  [{ ...baseline, chargedMicros: CAMPAIGN_BUDGET_MICROS - reservation + 1 }, 'EVAL_CUMULATIVE_BUDGET_STOP'],
  [{ ...baseline, invocations: 41 }, 'EVAL_CUMULATIVE_INVOCATION_STOP'],
])('rejects exhausted history before any execution or checkpoint: %j', async (prior, error) => {
  const h = harness({ prior });
  await expect(runCloudflareCampaign(h.ports)).rejects.toThrow(error);
  expect(h.ports.execute).not.toHaveBeenCalled();
  expect(h.ports.capture).not.toHaveBeenCalled();
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
});

test('reserves 60 slots while the real schedule uses 39 dispatches, 79 cumulative with baseline 40', async () => {
  const h = harness({ prior: { ...baseline, invocations: 40 } });
  const report = await runCloudflareCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, invocations: 39, cumulativeInvocations: 79 });
  expect(h.dispatchTimes).toHaveLength(39);
});

test('allows seven model calls per case and exactly 210 newly captured model calls', async () => {
  const h = harness({ result: (id, attempt) => resultFor(id, { modelCalls: 7 }, attempt), capture: attempt => ({
    chargedMicros: attempt * 100, modelCalls: attempt * 7, totalTokens: attempt * 1000,
    privateUsageComplete: true, usageKnown: true, record: { synthetic: true },
  }) });
  const report = await runCloudflareCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, modelCalls: 210, cumulativeModelCalls: 219 });
  expect(h.ports.execute).toHaveBeenCalledTimes(30);
});

test('blocks the third dispatch in a case without sending or checkpointing it', async () => {
  const h = harness({ dispatches: 3 });
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'EVAL_INVOCATION_STOP');
  expect(h.dispatchTimes).toHaveLength(2);
  expect(h.ports.pause).toHaveBeenCalledTimes(2);
  expect(report.invocations).toBe(2);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test.each((['chargedMicros', 'invocations', 'modelCalls', 'totalTokens'] as const).flatMap(field =>
  [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => ({ field, value }))))('rejects invalid history $field=$value', async ({ field, value }) => {
  const h = harness({ prior: { ...baseline, [field]: value } });
  await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.execute).not.toHaveBeenCalled();
  expect(h.ports.capture).not.toHaveBeenCalled();
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
});

test.each(['modelCalls', 'totalTokens'] as const)('rejects history missing %s instead of producing NaN cumulative evidence', async field => {
  const prior: Partial<CampaignBaseline> = { ...baseline };
  delete prior[field];
  const h = harness({ prior: prior as CampaignBaseline });
  await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.execute).not.toHaveBeenCalled();
});

test.each(['throw', 'private-incomplete', 'negative-cost', 'model-limit', 'invalid-tokens', 'cost-regression', 'call-regression'] as const)(
  'capture failure %s throws to preserve the isolated DB, with a sanitized checkpoint', async mode => {
    const regression = mode.endsWith('regression');
    const h = harness({ capture: attempt => {
      if (mode === 'throw') throw new Error('synthetic-private-capture-detail');
      return { chargedMicros: mode === 'negative-cost' ? -1 : mode === 'cost-regression' && attempt === 2 ? 99 : attempt * 100,
        modelCalls: mode === 'model-limit' ? 211 : mode === 'call-regression' && attempt === 2 ? 1 : attempt * 2,
        totalTokens: mode === 'invalid-tokens' ? NaN : attempt * 1000,
        privateUsageComplete: mode !== 'private-incomplete', usageKnown: true, record: { synthetic: true } };
    } });
    await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
    expect(h.ports.execute).toHaveBeenCalledTimes(regression ? 2 : 1);
    expect(h.checkpoints.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
    expect(JSON.stringify(h.checkpoints)).not.toContain('synthetic-private-capture-detail');
  });

test('a failed initial checkpoint prevents all execution', async () => {
  const h = harness();
  h.ports.checkpoint.mockRejectedValueOnce(new Error('CHECKPOINT_UNAVAILABLE'));
  await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
  expect(h.ports.execute).not.toHaveBeenCalled();
  expect(h.ports.capture).not.toHaveBeenCalled();
});

test('a failed dispatch checkpoint prevents dispatch but still captures the attempt', async () => {
  const h = harness();
  h.ports.capture.mockResolvedValue({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    privateUsageComplete: true, usageKnown: true, record: { synthetic: true } });
  h.ports.checkpoint.mockImplementationOnce(async report => { h.checkpoints.push(report); })
    .mockRejectedValueOnce(new Error('synthetic-private-checkpoint-detail'));
  const report = await runCloudflareCampaign(h.ports);
  expectStopped(report, 'EVAL_EXCEPTION_STOP');
  expect(h.dispatchTimes).toHaveLength(0);
  expect(report.invocations).toBe(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.checkpoints)).not.toContain('synthetic-private-checkpoint-detail');
});

test('checkpoint failure after capture propagates so evidence storage failure cannot allow cleanup', async () => {
  const h = harness({ dispatches: 1 });
  const original = h.ports.checkpoint.getMockImplementation()!;
  h.ports.checkpoint.mockImplementation(async report => {
    if (report.records.some(record => (record as { kind?: string }).kind === 'durable-audit')
      && report.stopped !== 'EVIDENCE_EXPORT_STOP') throw new Error('synthetic-private-checkpoint-detail');
    await original(report);
  });
  await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.checkpoints.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
});

test('rejects reusing a run across rounds even when its case ID matches', async () => {
  const h = harness({ result: id => resultFor(id) });
  expectStopped(await runCloudflareCampaign(h.ports), 'EVAL_EVIDENCE_STOP', 11);
  expect(h.ports.execute).toHaveBeenCalledTimes(11);
  expect(h.ports.capture).toHaveBeenCalledTimes(11);
});

test.each([
  { caseId: 'foreign-case' }, { usageRunId: 'foreign-run' }, { latencyMs: NaN },
] satisfies Partial<RunEvidence>[])('first campaign enforces common result binding and numeric checks: %j', async patch => {
  const h = harness({ result: id => resultFor(id, patch) });
  expectStopped(await runCloudflareCampaign(h.ports), 'EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('first campaign rejects two dispatches for a successful non-proposal', async () => {
  const h = harness({ dispatches: 2 });
  expectStopped(await runCloudflareCampaign(h.ports), 'EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('first campaign recomputes safety despite a forged clean grade', async () => {
  const h = harness({ result: id => ({ ...resultFor(id, { textReview: 'failed' }),
    grade: { pass: false, reasons: [], safetyFailures: [] } }) });
  expectStopped(await runCloudflareCampaign(h.ports), 'EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test.each(['call-mismatch', 'cost-mismatch', 'token-regression', 'unknown-with-total', 'over-seven'])(
  'first campaign enforces common capture contract: %s', async mode => {
    const h = harness({
      result: (id, attempt) => resultFor(id, { modelCalls: mode === 'over-seven' ? 8 : 2 }, attempt),
      capture: attempt => ({ chargedMicros: attempt * 100 + (mode === 'cost-mismatch' ? 1 : 0),
        modelCalls: mode === 'over-seven' ? 8 : attempt * 2 + (mode === 'call-mismatch' ? 1 : 0),
        totalTokens: mode === 'token-regression' && attempt === 2 ? 999 : attempt * 1000,
        privateUsageComplete: true, usageKnown: mode !== 'unknown-with-total', record: { synthetic: true } }),
    });
    await expect(runCloudflareCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
    expect(h.ports.execute).toHaveBeenCalledTimes(mode === 'token-regression' ? 2 : 1);
    expect(h.checkpoints.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
  });
