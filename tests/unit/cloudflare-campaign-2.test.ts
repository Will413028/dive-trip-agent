import { expect, test, vi } from 'vitest';
import { runCloudflareSecondCampaign, CLOUDFLARE_SECOND_CAMPAIGN_AUTHORIZATION,
  type SecondCampaignReport } from '../../evals/cloudflare-campaign-2';
import type { CampaignCapture } from '../../evals/cloudflare-campaign';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidenceV2 as gradeEvidence, type RunEvidenceV2 as RunEvidence } from '../../evals/evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

// Importing the scheduler must not load the historical IO implementation.
vi.mock('../../evals/cloudflare-carry-forward', () => { throw new Error('NO_CARRY_IO'); });
type Ports = Parameters<typeof runCloudflareSecondCampaign>[0];
type Result = Awaited<ReturnType<Ports['execute']>>;
const ids = ['locked-budget', 'free-afternoon', 'more-people', 'unknown-cost',
  'no-date', 'source-injection', 'lookup-timeout', 'impossible'];
const prior: Ports['prior'] = {
  sourceSha256: 'a4871418af3515b4b8a0b4370c53a3cc1836eb1566dcb9a99e71ead14e829cb2',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 8, modelCalls: 11, chargedMicros: 188267,
  observedTokens: 46665, totalTokens: null, remainingInvocationCeiling: 92, remainingReferenceMicros: 2811733,
};

function resultFor(caseId: string, patch: Partial<RunEvidence> = {}): Result {
  const input = evaluationInput(caseId), proposal = input.terminal === 'proposal';
  const after = structuredClone(input.before);
  if (caseId === 'free-afternoon') after.entries = after.entries.filter(e => e.id !== 'transfer');
  if (caseId === 'more-people') { after.requirements.people = 3; after.entries[0].rooms = 2; }
  const evidence: RunEvidence = {
    caseId, inputDigest: input.digest, runId: `synthetic-${caseId}`, before: input.before,
    beforeDecision: structuredClone(input.before), after, beforeVersion: 1, beforeDecisionVersion: 1,
    afterVersion: proposal ? 2 : 1, terminal: input.terminal as RunEvidence['terminal'], runStatus: 'succeeded',
    decision: proposal ? 'accept' : 'none', proposalId: proposal ? 'synthetic-proposal' : null,
    decisionRunId: proposal ? `synthetic-${caseId}` : null, decisionProposalId: proposal ? 'synthetic-proposal' : null,
    model: CLOUDFLARE_MODEL, usageRunId: `synthetic-${caseId}`, usageComplete: true,
    modelCalls: 2, toolCount: 2, visibleToolCount: 1, costMicros: 100, latencyMs: 1000, textReview: 'pending',
    faultObserved: input.fault, ...patch,
  };
  return { schemaVersion: 2, evidence, events: [], grade: gradeEvidence(evidence, CLOUDFLARE_MODEL) };
}

function harness(options: {
  result?: (id: string, attempt: number) => Result;
  capture?: (attempt: number) => CampaignCapture;
  dispatches?: number; workMs?: number;
} = {}) {
  let time = 100_000, attempts = 0;
  const snapshots: SecondCampaignReport[] = [], sent: number[] = [];
  const ports = {
    accountId: '1fd574e905257afa3cfd7db80cf70b23', prior: { ...prior }, now: () => time,
    pause: vi.fn(async (ms: number, signal?: AbortSignal) => { signal?.throwIfAborted(); time += ms; }),
    checkpoint: vi.fn(async (report: SecondCampaignReport) => { snapshots.push(report); }),
    execute: vi.fn(async (id: string, beforeDispatch: Parameters<Ports['execute']>[1]) => {
      const attempt = ++attempts;
      for (let n = 0; n < (options.dispatches ?? (evaluationInput(id).terminal === 'proposal' ? 2 : 1)); n++) {
        await beforeDispatch(new AbortController().signal);
        expect(snapshots.at(-1)?.invocations).toBe(sent.length + 1);
        expect(snapshots.at(-1)?.cumulativeInvocations).toBe(prior.invocations + sent.length + 1);
        sent.push(time); time += options.workMs ?? 1000;
      }
      return options.result?.(id, attempt) ?? resultFor(id);
    }),
    capture: vi.fn(async (): Promise<CampaignCapture> => options.capture?.(attempts) ?? ({
      chargedMicros: attempts * 100, modelCalls: attempts * 2, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true },
    })),
  } satisfies Ports;
  return { ports, snapshots, sent, advance: (ms: number) => { time += ms; } };
}
function slots(report: SecondCampaignReport) {
  return report.records.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'outcome' in r);
}

test('exact eight unattempted slots, durable dispatch spacing, pending gate and incomplete historical accounting', async () => {
  const h = harness(), before = structuredClone(h.ports.prior);
  const report = await runCloudflareSecondCampaign(h.ports);
  expect(CLOUDFLARE_SECOND_CAMPAIGN_AUTHORIZATION).toBe('second-8-unattempted-cases-cloudflare-free-tier-confirmed');
  expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual(ids);
  expect(slots(report).map(({ round, caseId, outcome }) => ({ round, caseId, outcome })))
    .toEqual(ids.map(caseId => ({ round: 1, caseId, outcome: 'completed' })));
  expect(report).toMatchObject({ schemaVersion: 2, stopped: null, maxModelCalls: 56, maxInvocations: 16,
    model: CLOUDFLARE_MODEL, chargedMicros: 800, modelCalls: 16, totalTokens: 8000,
    cumulativeChargedMicros: 189067, cumulativeModelCalls: 27, cumulativeTokens: null,
    accountingComplete: false, historicalUnknownReceipts: 1, dispatchAuthorized: false,
    textReview: 'pending', evaluationGatePassed: false, prior });
  expect(report.invocations).toBe(h.sent.length);
  expect(report.invocations).toBeLessThanOrEqual(16);
  expect(h.sent[0]).toBe(115_000);
  expect(h.sent.slice(1).every((t, i) => t - h.sent[i] === 15_000)).toBe(true);
  expect(h.snapshots[0]).toMatchObject({ schemaVersion: 2, invocations: 0, records: [] });
  expect(h.snapshots.every(saved => saved.schemaVersion === 2)).toBe(true);
  expect(h.snapshots.at(-1)).toEqual(report);
  expect(h.snapshots.every(s => s.cumulativeTokens === null && !s.accountingComplete && !s.evaluationGatePassed)).toBe(true);
  expect(h.ports.prior).toEqual(before);
  expect(report.records.filter(r => (r as { kind?: string }).kind === 'durable-audit')).toHaveLength(8);
});

test('allows exactly 56 new model calls and carries all 11 historical calls', async () => {
  const h = harness({ result: id => resultFor(id, { modelCalls: 7 }), capture: n => ({
    chargedMicros: n * 100, modelCalls: n * 7, totalTokens: n * 1000,
    privateUsageComplete: true, usageKnown: true, record: {},
  }) });
  expect(await runCloudflareSecondCampaign(h.ports)).toMatchObject({ stopped: null, modelCalls: 56, cumulativeModelCalls: 67 });
});

test('elapsed work counts toward the interval', async () => {
  const h = harness({ workMs: 20_000 });
  await runCloudflareSecondCampaign(h.ports);
  expect(h.ports.pause.mock.calls.map(([ms]) => ms)).toEqual([15000, ...Array(h.sent.length - 1).fill(0)]);
});

test('variable history/checkpoint latency cannot shorten actual dispatch spacing', async () => {
  const h = harness(); let checked = 0;
  h.ports.checkpoint.mockImplementation(async r => {
    h.snapshots.push(r);
    h.advance(r.invocations === 1 ? 20000 : 1);
  });
  const checkDispatch = vi.fn(async () => { h.advance(++checked === 1 ? 30000 : 1); });
  await runCloudflareSecondCampaign({ ...h.ports, checkDispatch });
  expect(checkDispatch).toHaveBeenCalledTimes(h.sent.length);
  expect(h.sent.slice(1).every((t, i) => t - h.sent[i] >= 15000)).toBe(true);
});

test('changed history gate prevents checkpointed dispatch and never retries', async () => {
  const h = harness({ capture: () => ({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    usageKnown: true, privateUsageComplete: true, record: {} }) });
  const checkDispatch = vi.fn(async () => { throw new Error('EVAL_HISTORY_CHANGED'); });
  const r = await runCloudflareSecondCampaign({ ...h.ports, checkDispatch });
  expect(r).toMatchObject({ stopped: 'EVAL_HISTORY_CHANGED', invocations: 0, cumulativeInvocations: 8 });
  expect(h.sent).toHaveLength(0);
  expect(checkDispatch).toHaveBeenCalledTimes(1);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('cancellation during dispatch checkpoint cannot escape into HTTP', async () => {
  const h = harness({ capture: () => ({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    usageKnown: true, privateUsageComplete: true, record: {} }) });
  const controller = new AbortController(); let sent = false;
  h.ports.execute.mockImplementationOnce(async (id, before) => {
    await before(controller.signal); sent = true; return resultFor(id);
  });
  h.ports.checkpoint.mockImplementation(async r => {
    h.snapshots.push(r); if (r.invocations) controller.abort();
  });
  expect(await runCloudflareSecondCampaign(h.ports)).toMatchObject({ stopped: 'EVAL_EXCEPTION_STOP', invocations: 1 });
  expect(sent).toBe(false);
});

test.each(Object.keys(prior) as (keyof typeof prior)[])('rejects changed or missing historical %s before ports', async field => {
  for (const missing of [false, true]) {
    const h = harness();
    const bad = h.ports.prior as Record<string, unknown>;
    if (missing) delete bad[field];
    else bad[field] = typeof prior[field] === 'number' ? Number(prior[field]) + 1 : 'changed';
    await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
    expect(h.ports.checkpoint).not.toHaveBeenCalled();
    expect(h.ports.execute).not.toHaveBeenCalled();
    expect(h.ports.capture).not.toHaveBeenCalled();
  }
});

test('pins the account and rejects promoting observed tokens to a known total', async () => {
  const h = harness(); h.ports.accountId = 'a'.repeat(32);
  await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  const g = harness(); Object.assign(g.ports.prior, { totalTokens: 46665 });
  await expect(runCloudflareSecondCampaign(g.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.execute).not.toHaveBeenCalled(); expect(g.ports.execute).not.toHaveBeenCalled();
});

test.each([
  [{ usageComplete: false }, 'UNKNOWN_USAGE_STOP'], [{ costMicros: null }, 'UNKNOWN_USAGE_STOP'],
  [{ runStatus: 'failed' }, 'FAILED_RUN_STOP'], [{ textReview: 'failed' }, 'SAFETY_EVIDENCE_STOP'],
  [{ latencyMs: 60000 }, 'DEADLINE_STOP'], [{ model: 'other' }, 'BINDING_OR_LIMIT_STOP'],
  [{ modelCalls: 0 }, 'BINDING_OR_LIMIT_STOP'], [{ caseId: 'ambiguous' }, 'EVAL_EVIDENCE_STOP'],
  [{ usageRunId: 'foreign' }, 'EVAL_EVIDENCE_STOP'], [{ latencyMs: NaN }, 'EVAL_EVIDENCE_STOP'],
] satisfies [Partial<RunEvidence>, string][])('stops on new evidence %j without retry', async (patch, reason) => {
  const h = harness({ result: id => resultFor(id, patch), capture: () => ({
    chargedMicros: 100, modelCalls: 'modelCalls' in patch ? patch.modelCalls : 2, totalTokens: 1000,
    privateUsageComplete: true, usageKnown: true, record: {},
  }) });
  const report = await runCloudflareSecondCampaign(h.ports);
  expect(report.stopped).toBe(reason);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
  expect(slots(report).slice(1)).toEqual(ids.slice(1).map(caseId => ({ round: 1, caseId, outcome: 'skipped', reason })));
});

test('new unknown retains charged reservation and both unknown totals', async () => {
  const h = harness({ capture: () => ({ chargedMicros: 183505, modelCalls: 2, totalTokens: null,
    usageKnown: false, privateUsageComplete: true, record: {} }) });
  const r = await runCloudflareSecondCampaign(h.ports);
  expect(r).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', chargedMicros: 183505, cumulativeChargedMicros: 371772,
    totalTokens: null, cumulativeTokens: null, accountingComplete: false });
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test.each(['call-mismatch', 'over-seven', 'cost-mismatch', 'regression', 'incomplete', 'unknown-with-total', 'throw'])(
  'capture %s fails closed and checkpoints retention failure', async mode => {
    const h = harness({ capture: n => {
      if (mode === 'throw') throw new Error('private-detail');
      return { chargedMicros: n * 100 + (mode === 'cost-mismatch' ? 1 : 0),
        modelCalls: mode === 'over-seven' ? 8 : mode === 'call-mismatch' ? 3 : n * 2,
        totalTokens: mode === 'regression' && n === 2 ? 999 : n * 1000,
        privateUsageComplete: mode !== 'incomplete', usageKnown: mode !== 'unknown-with-total', record: {} };
    } });
    await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
    expect(h.ports.execute).toHaveBeenCalledTimes(mode === 'regression' ? 2 : 1);
    expect(h.snapshots.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
    expect(JSON.stringify(h.snapshots)).not.toContain('private-detail');
  });

test('third HTTP dispatch is denied before sending', async () => {
  const h = harness({ dispatches: 3 });
  const report = await runCloudflareSecondCampaign(h.ports);
  expect(report.stopped).toBe('EVAL_INVOCATION_STOP');
  expect(h.sent).toHaveLength(2);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('execute failure is sanitized, captured once, and never retried', async () => {
  const h = harness();
  h.ports.execute.mockImplementationOnce(async (_id, before) => {
    await before(new AbortController().signal); throw new Error('private-detail');
  });
  h.ports.capture.mockResolvedValue({ chargedMicros: 183505, modelCalls: 1, totalTokens: null,
    usageKnown: false, privateUsageComplete: true, record: {} });
  const report = await runCloudflareSecondCampaign(h.ports);
  expect(report.stopped).not.toBeNull();
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report)).not.toContain('private-detail');
});

test('checkpoint failure prevents sending; conservative dispatch count remains', async () => {
  const h = harness();
  h.ports.capture.mockResolvedValue({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    privateUsageComplete: true, usageKnown: true, record: { synthetic: true } });
  h.ports.checkpoint.mockImplementationOnce(async r => { h.snapshots.push(r); })
    .mockRejectedValueOnce(new Error('private-detail'));
  const report = await runCloudflareSecondCampaign(h.ports);
  expect(h.sent).toHaveLength(0);
  expect(report).toMatchObject({ invocations: 1, stopped: 'EVAL_EXCEPTION_STOP' });
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
});

test('initial checkpoint failure prevents all attempts', async () => {
  const h = harness(); h.ports.checkpoint.mockRejectedValueOnce(new Error('OFFLINE_CHECKPOINT_FAILED'));
  await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('OFFLINE_CHECKPOINT_FAILED');
  expect(h.ports.execute).not.toHaveBeenCalled(); expect(h.ports.capture).not.toHaveBeenCalled();
});

test('forged clean grade cannot hide safety evidence', async () => {
  const h = harness({ result: id => ({ ...resultFor(id, { textReview: 'failed' }),
    grade: { pass: false, reasons: [], safetyFailures: [] } }) });
  expect((await runCloudflareSecondCampaign(h.ports)).stopped).toBe('EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('over-seven delta is rejected even when evidence agrees and batch total remains below 56', async () => {
  const h = harness({ result: id => resultFor(id, { modelCalls: 8 }), capture: () => ({
    chargedMicros: 100, modelCalls: 8, totalTokens: 1000, privateUsageComplete: true, usageKnown: true, record: {},
  }) });
  await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.snapshots.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
});

test('a repeated run cannot represent a new case', async () => {
  const h = harness({ result: (id, n) => resultFor(id, n === 2 ? {
    runId: 'synthetic-locked-budget', usageRunId: 'synthetic-locked-budget', decisionRunId: 'synthetic-locked-budget',
  } : {}) });
  expect((await runCloudflareSecondCampaign(h.ports)).stopped).toBe('EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(2);
});

test('success without a dispatch cannot advance the schedule', async () => {
  const h = harness({ dispatches: 0, result: id => resultFor(id, { modelCalls: 0, costMicros: 0 }),
    capture: () => ({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
      privateUsageComplete: true, usageKnown: true, record: {} }) });
  expect((await runCloudflareSecondCampaign(h.ports)).stopped).toBe('EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('cancelled dispatch never reaches HTTP and still retains capture', async () => {
  const h = harness();
  h.ports.execute.mockImplementationOnce(async (id, before) => {
    const controller = new AbortController(); controller.abort();
    await before(controller.signal);
    throw new Error(`UNREACHABLE_${id}`);
  });
  h.ports.capture.mockResolvedValue({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    usageKnown: true, privateUsageComplete: true, record: {} });
  expect(await runCloudflareSecondCampaign(h.ports)).toMatchObject({ stopped: 'EVAL_EXCEPTION_STOP', invocations: 0 });
  expect(h.ports.pause).not.toHaveBeenCalled();
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(1);
});

test('checkpoint failure after capture propagates with evidence retention stop', async () => {
  const h = harness();
  h.ports.checkpoint.mockImplementation(async r => {
    if (r.modelCalls && !r.stopped) throw new Error('private-detail');
    h.snapshots.push(r);
  });
  await expect(runCloudflareSecondCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(h.snapshots.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});

test('historical charge participates in the budget stop before the next case', async () => {
  const charge = 2700000;
  const h = harness({ result: id => resultFor(id, { costMicros: charge }), capture: () => ({
    chargedMicros: charge, modelCalls: 2, totalTokens: 1000,
    privateUsageComplete: true, usageKnown: true, record: {},
  }) });
  expect(await runCloudflareSecondCampaign(h.ports)).toMatchObject({
    stopped: 'BUDGET_STOP', chargedMicros: charge, cumulativeChargedMicros: charge + prior.chargedMicros,
  });
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});
