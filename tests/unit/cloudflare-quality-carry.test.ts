import { expect, test } from 'vitest';
import { compareCloudflareQualityCarry } from '../../evals/cloudflare-quality-carry';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { qualityCarryFixture, qualityAudits, qualityAttempts, syntheticId,
  type QualityCarryFixture } from '../support/cloudflare-quality-carry-fixture';

const compare = (f: QualityCarryFixture) => compareCloudflareQualityCarry(f.report, f.prior, f.snapshot);
const expected = { historyConsistent: true, dispatchAuthorized: false, accountingComplete: false,
  evaluationGatePassed: false, historicalUnknownReceipts: 1, invocations: 26, modelCalls: 38,
  chargedMicros: 204816, observedTokens: 183791, totalTokens: null,
  remainingInvocationCeiling: 74, remainingReferenceMicros: 2795184 };
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
type Mutation = (f: QualityCarryFixture) => void;
// Keep both sides equal so rejection exercises accounting/binding, not just deep equality.
const usageMutation = (mutate: (u: CloudflareUsageEvidence, f: QualityCarryFixture) => void): Mutation => f => {
  mutate(f.snapshot.usage[0], f);
  qualityAudits(f)[0].privateUsage = [structuredClone(f.snapshot.usage[0])];
};
const eventMutation = (mutate: (f: QualityCarryFixture) => void): Mutation => f => {
  mutate(f);
  qualityAudits(f)[0].events = structuredClone(f.snapshot.events.filter(e => e.run_id === f.snapshot.runs[0].id));
};

test('synthetic inventory has independent evidence, exact totals and cumulative audit checkpoints', () => {
  const f = qualityCarryFixture(), { snapshot: s } = f;
  expect(f.report.records).toHaveLength(44);
  expect(qualityAttempts(f)).toHaveLength(13);
  expect(qualityAudits(f)).toHaveLength(13);
  expect(f.report.records.filter(r => r.kind === 'skip')).toHaveLength(18);
  expect(s.counts).toEqual({ runs: 13, trips: 13, invocations: 16, calls: 24, reservations: 16, proposals: 3 });
  for (const key of ['id', 'trip_id', 'owner_id'] as const) expect(new Set(s.runs.map(r => r[key])).size).toBe(13);
  expect(s.runs.filter(r => r.proposal_id !== null)).toHaveLength(3);
  const receipts = s.usage.flatMap(u => u.invocations), calls = s.usage.flatMap(u => u.calls);
  expect(receipts).toHaveLength(16);
  expect(new Set(receipts.map(r => r.id)).size).toBe(16);
  expect(new Set(receipts.map(r => r.reservation_id)).size).toBe(16);
  expect(s.usage.map(u => u.calls.length)).toEqual([3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
  expect(s.usage.map(u => u.invocations.length)).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  expect(calls.reduce((n, c) => n + c.usage!.totalTokens, 0)).toBe(122599);
  expect(receipts.reduce((n, r) => n + Number(r.actual_cost_micros), 0)).toBe(14749);
  expect(s.events).toHaveLength(112);
  expect(qualityAudits(f).map(a => a.events.length)).toEqual([...Array<number>(12).fill(8), 16]);
  expect(qualityAudits(f).map(a => a.chargedMicros)).toEqual([1800, 3600, 5400, 6600, 7800, 9000, 10200, 11400, 12000, 12600, 13200, 13800, 14749]);
  expect(qualityAudits(f)[0].privateUsage[0]).not.toBe(s.usage[0]);
  expect(qualityAttempts(f)[0].evidence.after).not.toBe(s.runs[0].snapshot);
  expect(f.report.prior).not.toBe(f.prior);
  expect(qualityCarryFixture()).toEqual(f);
});

test('carries observed usage without authorizing dispatch, quality or complete accounting; never mutates inputs', () => {
  const f = qualityCarryFixture(), before = structuredClone(f);
  freeze(f);
  expect(compare(f)).toEqual(expected);
  expect(compare(f)).toEqual(expected);
  expect(f).toEqual(before);
});

test('matches runs, attempts and usage by identity rather than array position', () => {
  const f = qualityCarryFixture();
  f.snapshot.runs.reverse(); f.snapshot.usage.reverse();
  const attempts = qualityAttempts(f).reverse();
  let i = 0;
  f.report.records = f.report.records.map(r => r.kind === 'attempt' ? attempts[i++] : r);
  expect(compare(f)).toEqual(expected);
});

const mutations: [string, Mutation][] = [
  ['forged external prior', f => { f.prior.invocations++; }],
  ['forged report prior', f => { f.report.prior.observedTokens++; }],
  ['matching forged priors', f => { f.prior.chargedMicros--; f.report.prior.chargedMicros--; }],
  ['prior provenance digest', f => { f.prior.sourceSha256 = '0'.repeat(64); f.report.prior.sourceSha256 = f.prior.sourceSha256; }],
  ['extra prior field', f => { Object.assign(f.prior, { extra: 1 }); }],
  ['extra inventory field', f => { Object.assign(f.snapshot.counts, { extra: 1 }); }],
  ['missing usage row', f => { f.snapshot.usage.pop(); }],
  ['duplicate usage run', f => { f.snapshot.usage[1] = structuredClone(f.snapshot.usage[0]); }],
  ['report-only usage change', f => { qualityAudits(f)[0].privateUsage[0].calls[0].call_id = 'changed'; }],
  ['empty audit usage', f => { qualityAudits(f)[0].privateUsage = []; }],
  ['unknown usage', usageMutation(u => { u.calls[0].usage = null; })],
  ['missing usage', usageMutation(u => { Reflect.deleteProperty(u.calls[0], 'usage'); })],
  ['unknown actual cost', usageMutation(u => { u.invocations[0].actual_cost_micros = null; })],
  ['charged cost mismatch', usageMutation(u => { u.invocations[0].charged_cost_micros = '1201'; })],
  ['matching but wrong receipt costs', usageMutation(u => { u.invocations[0].charged_cost_micros = u.invocations[0].actual_cost_micros = '1201'; })],
  ['token sum mismatch', usageMutation(u => { u.calls[0].usage!.totalTokens++; })],
  ['negative tokens', usageMutation(u => { u.calls[0].usage!.promptTokens = -1; })],
  ['changed coherent usage cost', usageMutation(u => { u.calls[0].usage!.promptTokens += 10; u.calls[0].usage!.totalTokens += 10; })],
  ['missing provider evidence', usageMutation(u => { u.calls[0].provider_evidence = null; })],
  ['wrong returned model', usageMutation(u => { u.calls[0].provider_evidence!.returnedModel = 'foreign-model'; })],
  ['wrong price basis', usageMutation(u => { Object.assign(u.calls[0].provider_evidence!, { priceBasis: 'foreign-price' }); })],
  ['wrong provider evidence', usageMutation(u => { Object.assign(u.calls[0].provider_evidence!, { provider: 'gemini' }); })],
  ['wrong binding provider', usageMutation(u => { Object.assign(u.binding, { provider: 'gemini' }); })],
  ['wrong invocation provider', usageMutation(u => { Object.assign(u.invocations[0], { provider: 'gemini' }); })],
  ['wrong invocation model', usageMutation(u => { Object.assign(u.invocations[0], { model: 'foreign-model' }); })],
  ['wrong receipt account', usageMutation(u => { u.invocations[0].account_id = 'a'.repeat(32); })],
  ['coherent foreign account', usageMutation(u => { u.binding.accountId = 'a'.repeat(32); u.invocations.forEach(r => { r.account_id = u.binding.accountId; }); })],
  ['legacy usage schema', usageMutation(u => { Object.assign(u, { schemaVersion: 1 }); })],
  ['cross-run receipt', usageMutation((u, f) => { u.invocations[0].run_id = f.snapshot.runs[1].id; })],
  ['cross-run reservation', usageMutation((u, f) => { u.invocations[0].logical_run_id = f.snapshot.runs[1].id; })],
  ['cross-run call', usageMutation((u, f) => { u.calls[0].run_id = f.snapshot.runs[1].id; })],
  ['foreign invocation call', usageMutation((u, f) => { u.calls[0].invocation_id = f.snapshot.usage[1].invocations[0].id; })],
  ['duplicate call', usageMutation(u => { u.calls[1].call_id = u.calls[0].call_id; })],
  ['duplicate local receipt', usageMutation(u => { u.invocations[1].id = u.invocations[0].id; })],
  ['duplicate global receipt', usageMutation((u, f) => {
    const old = u.invocations[0].id, duplicate = f.snapshot.usage[1].invocations[0].id;
    u.invocations[0].id = duplicate; u.calls.filter(c => c.invocation_id === old).forEach(c => { c.invocation_id = duplicate; });
  })],
  ['duplicate global reservation', usageMutation((u, f) => { u.invocations[0].reservation_id = f.snapshot.usage[1].invocations[0].reservation_id; })],
  ['duplicate local reservation', usageMutation(u => { u.invocations[1].reservation_id = u.invocations[0].reservation_id; })],
  ['active receipt', usageMutation(u => { u.invocations[0].status = 'active'; })],
  ['unsettled reservation', usageMutation(u => { u.invocations[0].reservation_status = 'reserved'; })],
  ['incomplete call', usageMutation(u => { u.calls[0].status = 'started'; u.calls[0].completed_at = null; u.calls[0].usage = null; })],
  ['missing completion timestamp', usageMutation(u => { u.calls[0].completed_at = null; })],
  ['receipt with no calls', usageMutation(u => { u.calls[2].invocation_id = u.invocations[0].id; })],
  ['missing call', usageMutation(u => { u.calls.pop(); })],
  ['extra call', usageMutation(u => { u.calls.push({ ...structuredClone(u.calls[0]), call_id: 'extra-call' }); })],
  ['event body divergence', f => { f.snapshot.events[1].event.value = 'changed'; }],
  ['event sequence gap', eventMutation(f => { f.snapshot.events[1].sequence = 3; })],
  ['event sequence starts at zero', eventMutation(f => { f.snapshot.events[0].sequence = 0; })],
  ['event order', eventMutation(f => { [f.snapshot.events[1], f.snapshot.events[2]] = [f.snapshot.events[2], f.snapshot.events[1]]; })],
  ['wrong initial event', eventMutation(f => { f.snapshot.events[0].event.type = 'RUN_FINISHED'; })],
  ['wrong event trip', eventMutation(f => { f.snapshot.events[0].event.threadId = f.snapshot.runs[1].trip_id; })],
  ['cross-run event', f => { f.snapshot.events[1].run_id = f.snapshot.runs[1].id; }],
  ['missing event', f => { f.snapshot.events.pop(); }],
  ['extra event', f => { f.snapshot.events.push(structuredClone(f.snapshot.events[0])); }],
  ['audit events total below 112', f => { qualityAudits(f)[12].events.pop(); }],
  ['audit events total above 112', f => { qualityAudits(f)[12].events.push(structuredClone(f.snapshot.events[111])); }],
  ['foreign-run event hidden outside otherwise matching audit projections', f => {
    // Keep the inventory at 112 and every known run's sequence/projection valid.
    // The previous comparator ignored this orphan and accepted only 111 audited events.
    f.snapshot.events[111].run_id = syntheticId(999);
    qualityAudits(f)[12].events.pop();
  }],
  ['foreign-run event with audit total still 112', f => {
    f.snapshot.events[111].run_id = syntheticId(999);
    qualityAudits(f)[12].events[15].run_id = syntheticId(999);
  }],
  ['snapshot changes', f => { f.snapshot.runs[0].snapshot.requirements.divers++; }],
  ['version changes', f => { f.snapshot.runs[0].current_version++; }],
  ['run status changes', f => { f.snapshot.runs[0].status = 'failed'; }],
  ['proposal changes', f => { f.snapshot.runs[0].proposal_id = syntheticId(999); }],
  ['decision changes', f => { f.snapshot.runs[0].decision = false; }],
  ['interrupt changes', f => { f.snapshot.runs[0].interrupt_id = 'other'; }],
  ['duplicate snapshot run', f => { f.snapshot.runs[1] = structuredClone(f.snapshot.runs[0]); }],
  ['duplicate trip', f => { f.snapshot.runs[1].trip_id = f.snapshot.runs[0].trip_id; }],
  ['missing snapshot run', f => { f.snapshot.runs.pop(); }],
  ['duplicate audit run', f => { qualityAudits(f)[1].runs = structuredClone(qualityAudits(f)[0].runs); }],
  ['duplicate attempt run', f => { qualityAttempts(f)[1].evidence.runId = qualityAttempts(f)[0].evidence.runId; }],
  ['borrowed attempt', f => { qualityAttempts(f)[0].evidence.runId = syntheticId(999); }],
  ['borrowed audit', f => { qualityAudits(f)[0].runs[0].id = syntheticId(999); }],
  ['borrowed usage', f => { qualityAudits(f)[0].privateUsage = structuredClone(qualityAudits(f)[1].privateUsage); }],
  ['attempt case mismatch', f => { qualityAttempts(f)[0].caseId = qualityAttempts(f)[1].caseId; }],
  ['attempt round mismatch', f => { qualityAttempts(f)[0].round++; }],
  ['swapped attempt snapshots', f => {
    const [a, b] = qualityAttempts(f); [a.evidence.after, b.evidence.after] = [b.evidence.after, a.evidence.after];
  }],
  ['audit order changes', f => { [f.report.records[1], f.report.records[3]] = [f.report.records[3], f.report.records[1]]; }],
  ['per-case instead of cumulative cost', f => { qualityAudits(f)[1].chargedMicros = 1800; }],
  ['wrong cumulative checkpoint', f => { qualityAudits(f)[0].chargedMicros++; }],
  ['incomplete private audit', f => { qualityAudits(f)[0].privateUsageComplete = false; }],
  ['non-quiescent audit', f => { qualityAudits(f)[0].quiescent = false; }],
  ['missing audit with same record count', f => { f.report.records[1] = structuredClone(f.report.records[43]); }],
  ['missing attempt with same record count', f => { f.report.records[0] = structuredClone(f.report.records[43]); }],
  ['extra executed attempt with same record count', f => { f.report.records[43] = structuredClone(f.report.records[0]); }],
  ['extra audit with same record count', f => { f.report.records[43] = structuredClone(f.report.records[1]); }],
  ['missing record', f => { f.report.records.pop(); }],
  ['extra record', f => { f.report.records.push(structuredClone(f.report.records[43])); }],
  // Preserve cost (ceil(5999 / 10) = 600) but change the aggregate token count.
  ['aggregate tokens despite valid per-call sums and costs', usageMutation(u => { u.calls[0].usage!.promptTokens--; u.calls[0].usage!.totalTokens--; })],
];
for (const [name, value] of Object.entries({ null: null, undefined, array: [], string: 'snapshot', number: 1, boolean: false })) {
  mutations.push([`matching non-object after and snapshot: ${name}`, f => {
    Object.assign(qualityAttempts(f)[0].evidence, { after: value });
    Object.assign(f.snapshot.runs[0], { snapshot: value });
  }]);
}
mutations.push(['missing both after and snapshot', f => {
  Reflect.deleteProperty(qualityAttempts(f)[0].evidence, 'after');
  Reflect.deleteProperty(f.snapshot.runs[0], 'snapshot');
}]);
for (const key of ['runs', 'trips', 'invocations', 'calls', 'reservations', 'proposals'] as const) {
  mutations.push([`extra ${key} inventory`, f => { f.snapshot.counts[key]++; }]);
}
for (const [key, value] of Object.entries({ model: 'foreign-model', accountId: 'a'.repeat(32),
  stopped: null, textReview: 'passed', evaluationGatePassed: true, accountingComplete: true,
  dispatchAuthorized: true, historicalUnknownReceipts: 0, invocations: 17, modelCalls: 25,
  chargedMicros: 14750, totalTokens: 122600, cumulativeInvocations: 27, cumulativeModelCalls: 39,
  cumulativeChargedMicros: 204817, cumulativeTokens: 183791 })) {
  mutations.push([`forged report ${key}`, f => { Object.assign(f.report, { [key]: value }); }]);
}

test.each(mutations)('rejects %s without mutating input or exposing evidence', (_, mutate) => {
  const f = qualityCarryFixture();
  mutate(f);
  const before = structuredClone(f);
  freeze(f);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_QUALITY_CARRY_INVALID$/);
  expect(f).toEqual(before);
});

test.each(['report', 'prior', 'snapshot'] as const)('rejects malformed %s', key => {
  const f = qualityCarryFixture();
  for (const invalid of [null, undefined, [], 'invalid', {}]) {
    const args = { ...f, [key]: invalid };
    expect(() => compareCloudflareQualityCarry(args.report, args.prior, args.snapshot)).toThrow(/^CLOUDFLARE_QUALITY_CARRY_INVALID$/);
  }
});
