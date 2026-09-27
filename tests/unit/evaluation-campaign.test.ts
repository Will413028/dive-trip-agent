import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import cases from '../../evals/cases.json';
import { campaignPreflight, carryCampaignUsage } from '../../evals/campaign-policy';

function report() {
  return { model: 'model', transport: 'real-gemini-via-http-handler', stopped: null, chargedMicros: 300,
    records: [1, 2, 3].flatMap(round => cases.map(c => ({ round, caseId: c.id, outcome: 'completed',
      evidence: { runId: randomUUID(), model: 'model', runStatus: 'succeeded', usageComplete: true,
        costMicros: 10, decision: c.terminal === 'proposal' ? 'accept' : 'none' },
      grade: { safetyFailures: [] as string[] } }))) };
}
test('carry retained campaign costs and start/resume invocations, not cumulative totals', () => {
  const first = report(), second = { ...report(), cumulativeChargedMicros: 600 };
  expect(carryCampaignUsage([first, second], 'model')).toEqual({ chargedMicros: 600, invocations: 78 });
  expect(() => campaignPreflight({ chargedMicros: 300, invocations: 39 }, 1_856_512)).not.toThrow();
  expect(() => campaignPreflight({ chargedMicros: 600, invocations: 78 }, 1_856_512)).toThrow('EVAL_CUMULATIVE_INVOCATION_STOP');
});
test('unknown, incomplete, stopped, duplicate or mismatched history cannot reset quota', () => {
  const first = report();
  expect(() => carryCampaignUsage([first, first], 'model')).toThrow('EVAL_HISTORY_BINDING_INVALID');
  expect(() => carryCampaignUsage([{ ...first, stopped: 'UNKNOWN_USAGE_STOP' }], 'model')).toThrow();
  expect(() => carryCampaignUsage([{ ...first, records: first.records.slice(1) }], 'model')).toThrow('EVAL_HISTORY_INCOMPLETE');
  expect(() => carryCampaignUsage([{ ...first, chargedMicros: 0 }], 'model')).toThrow('EVAL_HISTORY_COST_MISMATCH');
  first.records[0].evidence.usageComplete = false;
  expect(() => carryCampaignUsage([first], 'model')).toThrow();
});
test('reject invalid caps before dispatch', () => {
  expect(() => campaignPreflight({ chargedMicros: 2_000_000, invocations: 0 }, 1_856_512)).toThrow('EVAL_CUMULATIVE_BUDGET_STOP');
  expect(() => campaignPreflight({ chargedMicros: -1, invocations: 0 }, 1)).toThrow('EVAL_INVALID_BUDGET');
});

test('explicit dispatch counts cannot contradict inferred history and reset quota', () => {
  expect(() => carryCampaignUsage([{ ...report(), invocations: 45 }], 'model')).toThrow('EVAL_HISTORY_INVOCATION_MISMATCH');
  expect(() => carryCampaignUsage([{ ...report(), invocations: 30 }], 'model')).toThrow('EVAL_HISTORY_INVOCATION_MISMATCH');
  expect(carryCampaignUsage([{ ...report(), invocations: 39 }], 'model').invocations).toBe(39);
});

test('an incomplete last private export blocks another batch even with 30 completed attempts', () => {
  const first = report();
  const interrupted = { ...first, records: [...first.records, { kind: 'durable-audit', privateUsageComplete: false }] };
  expect(() => carryCampaignUsage([interrupted], 'model')).toThrow('EVAL_HISTORY_PRIVATE_USAGE_INCOMPLETE');
});
