import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareRecoveryCampaign, type RecoveryCampaignReport } from '../../evals/cloudflare-recovery-campaign';
import type { CampaignCapture } from '../../evals/cloudflare-campaign';
import { evaluationInput } from '../../evals/fixtures';
import { recoveryAccount, recoveryPrior, recoveryResult } from '../support/cloudflare-recovery-fixture';

type Ports = Parameters<typeof runCloudflareRecoveryCampaign>[0];
const first = ['unknown-cost', 'no-date'];
const schedule = [
  ...first.map(caseId => ({ round: 1, caseId })),
  ...[1, 2, 3].flatMap(round => cases.filter(c => round !== 1 || !first.includes(c.id))
    .map(c => ({ round, caseId: c.id }))),
];

function harness(options: {
  result?: (id: string, attempt: number) => ReturnType<typeof recoveryResult>;
  capture?: (attempt: number) => CampaignCapture;
  dispatches?: number;
} = {}) {
  let time = 100_000, attempts = 0;
  const checkpoints: RecoveryCampaignReport[] = [];
  const dispatchTimes: number[] = [];
  const ports = {
    accountId: recoveryAccount, prior: { ...recoveryPrior },
    reviewPreflight: vi.fn<(report: RecoveryCampaignReport) => Promise<boolean>>(async () => true),
    checkDispatch: vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); }),
    now: () => time,
    pause: vi.fn(async (ms: number, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      time += ms;
    }),
    checkpoint: vi.fn(async (report: RecoveryCampaignReport) => { checkpoints.push(report); }),
    execute: vi.fn(async (id: string, beforeDispatch: Parameters<Ports['execute']>[1]) => {
      expect(checkpoints.length).toBeGreaterThan(0);
      const n = ++attempts;
      const signal = new AbortController().signal;
      const count = options.dispatches ?? (evaluationInput(id).terminal === 'proposal' ? 2 : 1);
      for (let i = 0; i < count; i++) {
        await beforeDispatch(signal);
        expect(checkpoints.at(-1)?.invocations).toBe(dispatchTimes.length + 1);
        dispatchTimes.push(time);
        time += 4000;
      }
      return options.result?.(id, n) ?? recoveryResult(id, n);
    }),
    capture: vi.fn(async (): Promise<CampaignCapture> => options.capture?.(attempts) ?? {
      chargedMicros: attempts * 100, modelCalls: attempts * 2, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true },
    }),
  } satisfies Ports;
  return { ports, checkpoints, dispatchTimes };
}

function expectRemaining(report: RecoveryCampaignReport, attempted: number, reason: string) {
  expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped'))
    .toEqual(schedule.slice(attempted).map(slot => ({ ...slot, outcome: 'skipped', reason })));
}

test('two captured round-one cases reviewed before the other 28; exactly 30 unique round/case slots', async () => {
  const h = harness();
  h.ports.reviewPreflight.mockImplementation(async report => {
    expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual(first);
    expect(h.ports.capture).toHaveBeenCalledTimes(2);
    expect(report).toEqual(h.checkpoints.at(-1));
    expect(report).toMatchObject({ invocations: 2, modelCalls: 4, totalTokens: 2000 });
    expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'completed'))
      .toEqual(first.map(caseId => expect.objectContaining({ round: 1, caseId, outcome: 'completed' })));
    return true;
  });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual(schedule.map(s => s.caseId));
  const slots = r.records.filter(row => row && typeof row === 'object' && 'outcome' in row)
    .map(row => { const { round, caseId } = row as { round: number; caseId: string }; return { round, caseId }; });
  expect(slots).toEqual(schedule);
  expect(new Set(slots.map(s => `${s.round}:${s.caseId}`)).size).toBe(30);
  for (const round of [1, 2, 3]) expect(slots.filter(s => s.round === round)).toHaveLength(10);
  expect(h.ports.reviewPreflight).toHaveBeenCalledTimes(1);
  expect(h.ports.capture).toHaveBeenCalledTimes(30);
  expect(h.ports.checkDispatch).toHaveBeenCalledTimes(39);
  expect(r).toMatchObject({ schemaVersion: 2, prior: recoveryPrior, stopped: null, maxModelCalls: 210, maxInvocations: 60,
    invocations: 39, modelCalls: 60, chargedMicros: 3000, totalTokens: 30000,
    cumulativeInvocations: 78, cumulativeModelCalls: 116, cumulativeChargedMicros: 399708,
    cumulativeTokens: null, historicalUnknownReceipts: 2, accountingComplete: false,
    dispatchAuthorized: false, evaluationGatePassed: false, textReview: 'pending' });
  for (const saved of h.checkpoints) expect(saved).toMatchObject({ schemaVersion: 2, prior: recoveryPrior,
    cumulativeTokens: null, historicalUnknownReceipts: 2, accountingComplete: false,
    dispatchAuthorized: false, evaluationGatePassed: false });
  expect(h.checkpoints[0].records).toEqual([]);
  expect(h.dispatchTimes.slice(1).every((t, i) => t - h.dispatchTimes[i] >= 15000)).toBe(true);
});

test('all 30 cases can consume seven calls: 210 new / 266 cumulative, with 60 invocation ceiling below 100', async () => {
  const h = harness({ result: (id, n) => recoveryResult(id, n, { modelCalls: 7 }),
    capture: n => ({ chargedMicros: n * 100, modelCalls: n * 7, totalTokens: n * 1000,
      usageKnown: true, privateUsageComplete: true, record: {} }) });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r).toMatchObject({ stopped: null, modelCalls: 210, cumulativeModelCalls: 266, maxInvocations: 60 });
  expect(r.prior.invocations + r.maxInvocations).toBe(99);
  expect(r.invocations).toBeLessThanOrEqual(60);
  expect(h.ports.execute).toHaveBeenCalledTimes(30);
});

test('capture cannot silently admit a 211th model call', async () => {
  const h = harness({ result: (id, n) => recoveryResult(id, n, { modelCalls: n === 30 ? 8 : 7 }),
    capture: n => ({ chargedMicros: n * 100, modelCalls: n * 7 + (n === 30 ? 1 : 0),
      totalTokens: n * 1000, usageKnown: true, privateUsageComplete: true, record: {} }) });
  await expect(runCloudflareRecoveryCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(h.checkpoints.at(-1)).toMatchObject({ stopped: 'EVIDENCE_EXPORT_STOP', modelCalls: 203 });
  expect(h.ports.execute).toHaveBeenCalledTimes(30);
});

test('a third start/resume in one logical run is denied before dispatch and never retried', async () => {
  const h = harness({ dispatches: 3 });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r).toMatchObject({ stopped: 'EVAL_INVOCATION_STOP', invocations: 2, cumulativeInvocations: 41 });
  expect(h.ports.checkDispatch).toHaveBeenCalledTimes(2);
  expect(h.dispatchTimes).toHaveLength(2);
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expectRemaining(r, 1, 'EVAL_INVOCATION_STOP');
});

test.each([1, 2, 3, 12])('failure at attempt %i stops without retry and skips every later slot', async at => {
  const h = harness({ result: (id, n) => recoveryResult(id, n, n === at ? { runStatus: 'failed' } : {}) });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r.stopped).toBe('FAILED_RUN_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(at);
  expect(h.ports.capture).toHaveBeenCalledTimes(at);
  expect(h.ports.reviewPreflight).toHaveBeenCalledTimes(at <= 2 ? 0 : 1);
  expectRemaining(r, at, 'FAILED_RUN_STOP');
});

test.each([1, 2])('unknown accounting in preflight %i skips review and all remaining slots', async at => {
  const h = harness({ result: (id, n) => recoveryResult(id, n, n === at ? { usageComplete: false, costMicros: null } : {}),
    capture: n => ({ chargedMicros: n * 100, modelCalls: n * 2, totalTokens: n === at ? null : n * 1000,
      usageKnown: n !== at, privateUsageComplete: true, record: {} }) });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', cumulativeTokens: null, totalTokens: null });
  expect(h.ports.execute).toHaveBeenCalledTimes(at);
  expect(h.ports.capture).toHaveBeenCalledTimes(at);
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expectRemaining(r, at, 'UNKNOWN_USAGE_STOP');
});

test.each([false, undefined, null, 1, 'true', {}, 'throws'])('only boolean true authorizes the later 28: %j', async value => {
  const h = harness();
  h.ports.reviewPreflight.mockImplementation(async () => {
    if (value === 'throws') throw new Error('private-review-detail');
    return value as boolean;
  });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r.stopped).toBe('PREFLIGHT_TEXT_REVIEW_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(2);
  expect(h.ports.reviewPreflight).toHaveBeenCalledTimes(1);
  expectRemaining(r, 2, 'PREFLIGHT_TEXT_REVIEW_STOP');
  expect(JSON.stringify(r)).not.toContain('private-review-detail');
});

test.each([1, 2])('terminal goal mismatch in preflight %i prevents later cases and prose review', async at => {
  const h = harness({ result: (id, n) => recoveryResult(id, n, n === at ? { terminal: 'blocked' } : {}) });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r.stopped).toBe('PREFLIGHT_GOAL_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(at);
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expectRemaining(r, at, 'PREFLIGHT_GOAL_STOP');
});

test.each([2, 3])('run ID reused across phase boundary at attempt %i is rejected', async at => {
  const h = harness({ result: (id, n) => {
    const runId = n === at ? 'synthetic-unknown-cost-1' : `synthetic-${id}-${n}`;
    return recoveryResult(id, n, { runId, usageRunId: runId,
      decisionRunId: evaluationInput(id).terminal === 'proposal' ? runId : null });
  } });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r.stopped).toBe('EVAL_EVIDENCE_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(at);
  expectRemaining(r, at, 'EVAL_EVIDENCE_STOP');
});

test.each(Object.entries(recoveryPrior))('changed pinned history %s rejects before IO', async (key, original) => {
  const value = typeof original === 'number' ? original + 1 : typeof original === 'boolean' ? !original
    : original === null ? 0 : 'a'.repeat(64);
  const h = harness(); Object.assign(h.ports.prior, { [key]: value });
  await expect(runCloudflareRecoveryCampaign(h.ports)).rejects.toThrow();
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
  expect(h.ports.checkDispatch).not.toHaveBeenCalled();
  expect(h.ports.execute).not.toHaveBeenCalled();
});

test.each(['checkDispatch', 'reviewPreflight', 'accountId'] as const)('invalid or absent %s fails before IO', async key => {
  const h = harness(); Object.assign(h.ports, { [key]: key === 'accountId' ? 'a'.repeat(32) : undefined });
  await expect(runCloudflareRecoveryCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
  expect(h.ports.execute).not.toHaveBeenCalled();
});

test.each([1, 2, 3, 5])('dispatch gate denial #%i prevents that start/resume and every subsequent one', async denyAt => {
  const h = harness();
  // Earlier cases have ordinary accounting; the denied case contributes no calls.
  let finished = 0;
  h.ports.execute.mockImplementation(async (id, beforeDispatch) => {
    const signal = new AbortController().signal;
    for (let i = 0; i < (evaluationInput(id).terminal === 'proposal' ? 2 : 1); i++) {
      await beforeDispatch(signal);
      h.dispatchTimes.push(h.ports.now());
    }
    return recoveryResult(id, ++finished);
  });
  h.ports.capture.mockImplementation(async () => ({ chargedMicros: finished * 100, modelCalls: finished * 2,
    totalTokens: finished * 1000, usageKnown: true, privateUsageComplete: true, record: {} }));
  h.ports.checkDispatch.mockImplementation(async signal => {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(h.checkpoints.at(-1)?.invocations).toBe(h.ports.checkDispatch.mock.calls.length - 1);
    if (h.ports.checkDispatch.mock.calls.length === denyAt) throw new Error('EVAL_HISTORY_CHANGED');
  });
  const r = await runCloudflareRecoveryCampaign(h.ports);
  expect(r).toMatchObject({ stopped: 'EVAL_HISTORY_CHANGED', invocations: denyAt - 1,
    cumulativeInvocations: 39 + denyAt - 1 });
  expect(h.ports.checkDispatch).toHaveBeenCalledTimes(denyAt);
  expect(h.dispatchTimes).toHaveLength(denyAt - 1);
  expectRemaining(r, h.ports.execute.mock.calls.length, 'EVAL_HISTORY_CHANGED');
});
