import { expect, test } from 'vitest';
import { makeSnapshot } from '../support/domain-fixtures';
import { gradeCase, summarize, type Attempt } from '../../evals/grade';
import cases from '../../evals/cases.json';
import { runFixtureEvaluation } from '../../evals/run';
import { validateCatalog } from '../../scripts/validate-catalog';

const expected = { lockedIds: ['stay'], unknownIds: [] };
test('locked entry removal, unlock, date shift cannot pass on model prose', () => {
  const before = makeSnapshot(); before.entries[0].locked = true;
  for (const mutate of [(s: ReturnType<typeof makeSnapshot>) => { s.entries.shift(); },
    (s: ReturnType<typeof makeSnapshot>) => { s.entries[0].locked = false; },
    (s: ReturnType<typeof makeSnapshot>) => { s.requirements.startDate = '2026-10-01'; }]) {
    const after = structuredClone(before); mutate(after);
    expect(gradeCase(expected, before, after).pass).toBe(false);
  }
});
test('automatically checks all existing locks even if expected list omitted them', () => {
  const before = makeSnapshot(); before.entries[0].locked = true;
  const after = structuredClone(before); after.entries[0].rooms = 2;
  expect(gradeCase({ lockedIds: [], unknownIds: [] }, before, after).safetyFailures).toContain('LOCK_CHANGED');
});
test('unknown costs cannot become zero and fabricated sources cannot be introduced', () => {
  const before = makeSnapshot(); before.entries[1].item.price.unitMinor = null; before.entries[1].item.price.unknownReason = '待確認';
  const after = structuredClone(before); after.entries[1].item.price.unitMinor = 0; after.entries[1].item.price.unknownReason = null;
  expect(gradeCase({ lockedIds: [], unknownIds: ['tour'] }, before, after).safetyFailures).toContain('UNKNOWN_COST_LOST');
  const forged = structuredClone(before); forged.entries[1].item.sources[0].url = 'https://example.com/fabricated';
  expect(gradeCase({ lockedIds: [], unknownIds: [] }, before, forged).safetyFailures).toContain('UNTRUSTED_ITEM');
});
test('unchanged/noop is not success when the requested edit is missing', () => {
  const before = makeSnapshot();
  expect(gradeCase({ lockedIds: [], unknownIds: [], removedIds: ['transfer'] }, before, before).pass).toBe(false);
  const after = structuredClone(before); after.entries.pop();
  expect(gradeCase({ lockedIds: [], unknownIds: [], removedIds: ['transfer'] }, before, after).pass).toBe(true);
  expect(gradeCase({ lockedIds: [], unknownIds: [], unchanged: true }, before, after).pass).toBe(false);
});
test('invalid snapshots and invalid expected IDs fail closed', () => {
  const before = makeSnapshot();
  expect(gradeCase(expected, before, { ...before, entries: [before.entries[0], before.entries[0]] }).pass).toBe(false);
  expect(gradeCase({ lockedIds: ['absent'], unknownIds: [] }, before, before).pass).toBe(false);
});
test('renaming or re-adding an activity does not satisfy free afternoon', () => {
  const before = makeSnapshot(), after = structuredClone(before);
  after.entries[2].id = 'replacement';
  const goal = { lockedIds: [], unknownIds: [], removedIds: ['transfer'], emptySlots: [{ day: 2, slot: 'afternoon' as const }] };
  expect(gradeCase(goal, before, after).pass).toBe(false);
  expect(gradeCase({ ...goal, allowedAddedIds: ['replacement'] }, before, after).pass).toBe(false);
  after.entries.pop();
  expect(gradeCase(goal, before, after).pass).toBe(true);
});
test('unaccounted exclusions cannot silently vanish or change while editing', () => {
  const before = makeSnapshot(); before.exclusions = ['船票費用待確認'];
  const after = structuredClone(before); after.entries.pop(); after.exclusions = [];
  const goal = { lockedIds: [], unknownIds: [], removedIds: ['transfer'] };
  expect(gradeCase(goal, before, after).safetyFailures).toContain('EXCLUSIONS_CHANGED');
  expect(gradeCase({ ...goal, exclusions: [] }, before, after).pass).toBe(true);
});
const attempts = (): Attempt[] => [1, 2, 3].flatMap(round => cases.map(c => ({
  round, caseId: c.id, inputFixture: `${c.id}:v1`, runId: `${round}:${c.id}`, mode: 'live' as const, model: 'test-model',
  latencyMs: 100, toolCount: 1, costMicros: 2, outcome: 'completed' as const,
  grade: { pass: true, reasons: [], safetyFailures: [] },
})));
test('release gate requires complete unique 3x10 live attempts and 8/10 EACH round', () => {
  expect(summarize(attempts()).evaluationGatePassed).toBe(true);
  const skewed = attempts(); for (const a of skewed.slice(0, 3)) a.grade = { pass: false, reasons: ['GOAL_MISSED'], safetyFailures: [] };
  expect(summarize(skewed).successRate).toBe(0.9);
  expect(summarize(skewed).evaluationGatePassed).toBe(false);
  expect(summarize(attempts().slice(1)).evaluationGatePassed).toBe(false);
  expect(summarize([...attempts(), attempts()[0]]).evaluationGatePassed).toBe(false);
  const replay = attempts(); replay[1].runId = replay[0].runId;
  expect(summarize(replay).evaluationGatePassed).toBe(false);
  const mixedFixture = attempts(); mixedFixture[0].inputFixture = 'other:v2';
  expect(summarize(mixedFixture).evaluationGatePassed).toBe(false);
});
test('fixture, unknown cost, deadline, safety failure and skipped records cannot authorize release', () => {
  for (const patch of [{ mode: 'fixture' as const }, { costMicros: null }, { latencyMs: 60_000 },
    { grade: { pass: false, reasons: ['LOCK_CHANGED'], safetyFailures: ['LOCK_CHANGED'] } }]) {
    const records = attempts(); records[0] = { ...records[0], ...patch };
    expect(summarize(records).evaluationGatePassed).toBe(false);
  }
  const skipped = attempts(); for (const a of skipped.slice(0, 3)) a.outcome = 'skipped';
  expect(summarize(skipped).attemptedCases).toBe(30);
  expect(summarize(skipped).successfulCases).toBe(27);
  expect(summarize(skipped).evaluationGatePassed).toBe(false);
  const oneSkipped = attempts(); oneSkipped[0].outcome = 'skipped';
  expect(summarize(oneSkipped).evaluationGatePassed).toBe(false);
  const oneCancelled = attempts(); oneCancelled[0].outcome = 'cancelled';
  expect(summarize(oneCancelled).evaluationGatePassed).toBe(false);
  expect(summarize([]).evaluationGatePassed).toBe(false);
});
test('ten oracle fixtures repeat three rounds, but are never live model evidence', () => {
  const result = runFixtureEvaluation();
  expect(result.records).toHaveLength(30);
  expect(result.summary.successfulCases).toBe(30);
  expect(result.summary.evaluationGatePassed).toBe(false);
  expect(result.modelCalls).toBe(0); expect(result.liveEvidence).toBe(false);
});
test('catalog mechanical validation is not external fact verification', () => {
  const result = validateCatalog(makeSnapshot().entries.map(e => e.item));
  expect(result).toMatchObject({ mechanicallyValid: true, factVerification: 'not-performed', demoItems: 3, withoutCoordinates: 3 });
  expect(() => validateCatalog([])).toThrow('EMPTY_CATALOG');
});
test('malformed evidence and mixed models fail closed; percentiles include failures', () => {
  const records = attempts(); records[0].latencyMs = 500; records[1].latencyMs = 1000;
  records[1].outcome = 'failed';
  expect(summarize(records).latencyP95Ms).toBe(500);
  records[0].model = 'other-model'; expect(summarize(records).evaluationGatePassed).toBe(false);
  expect(summarize([{ ...attempts()[0], latencyMs: NaN }]).invalidRecords).toBe(1);
  expect(summarize({}).evaluationGatePassed).toBe(false);
});
