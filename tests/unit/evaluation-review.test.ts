import { expect, test } from 'vitest';
import cases from '../../evals/cases.json';
import { evaluationInput } from '../../evals/fixtures';
import { buildHistoricalReviewPacket as buildReviewPacket, buildReviewPacket as buildAcceptedReviewPacket } from '../../evals/review-packet';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';

function attempt(caseId = 'non-diver', round = 1) {
  const input = evaluationInput(caseId);
  const after = structuredClone(input.before);
  if (caseId === 'non-diver') {
    after.requirements.divers = 0;
    after.requirements.startDate = '2026-10-01'; // Original campaign regression must stay visible.
  }
  return { round, caseId, outcome: 'completed',
    evidence: { caseId, runId: `original-${round}-${caseId}`, inputDigest: 'a'.repeat(64),
      terminal: input.terminal, runStatus: 'succeeded', before: input.before, after },
    events: [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: '費用' },
      { type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'calculateBudget' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: '是零元' },
      { type: 'TOOL_CALL_RESULT', messageId: 'result-1', toolCallId: 'tool-1', content: 'not model prose' },
      { type: 'TOOL_CALL_START', toolCallId: 'tool-2', toolCallName: 'calculateBudget' },
    ],
    grade: { pass: false, reasons: ['GOAL_MISSED', 'TEXT_REVIEW_REQUIRED'], safetyFailures: [] },
  };
}
function report(records: unknown[] = [attempt()]) {
  return { model: 'offline-test', transport: 'real-gemini-via-http-handler', budgetMicros: 3000000,
    chargedMicros: 12, stopped: null, textReview: 'passed', evaluationGatePassed: true, records };
}
function durable(caseId = 'non-diver', round = 1) {
  return { round, caseId, kind: 'durable-audit', runs: [], chargedMicros: 12,
    events: [{ run_id: 'durable-run', sequence: 1,
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'partial', delta: 'Partial answer' } }] };
}

test('preserves historical identity, failing grade and prose without interpreting expected terminal as observed', () => {
  const input = report();
  const original = structuredClone(input);
  const packet = buildReviewPacket(input);
  const row = packet.cases.find(row => row.caseId === 'non-diver' && row.round === 1)!;
  expect(row).toMatchObject({ round: 1, caseId: 'non-diver', runId: 'original-1-non-diver',
    inputDigest: 'a'.repeat(64), expectedTerminal: { value: 'proposal', observed: false },
    observedTerminal: null, modelProse: '費用是零元', actualToolCallNames: ['calculateBudget', 'calculateBudget'],
    originalGrade: attempt().grade, textReview: 'pending',
    budget: { before: { knownMinor: 430000 }, after: { knownMinor: 430000 } },
    changedEntryIds: [],
  });
  expect(row.requirementDiffs).toEqual([
    { path: '/requirements/divers', before: 1, after: 0 },
    { path: '/requirements/startDate', before: null, after: '2026-10-01' },
  ]);
  expect(packet.evaluationGatePassed).toBe(false);
  expect(packet.textReview).toBe('pending');
  expect(input).toEqual(original);
  row.originalGrade!.reasons.push('packet-only');
  expect(input).toEqual(original);
  expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
});

test('computes stable changed entry IDs and authoritative budget for removed and edited entries', () => {
  const row = attempt('more-people');
  row.evidence.after.requirements.people = 3;
  row.evidence.after.entries[0].rooms = 2;
  row.evidence.after.entries = row.evidence.after.entries.filter(entry => entry.id !== 'transfer');
  const review = buildReviewPacket(report([row])).cases.find(c => c.caseId === row.caseId)!;
  expect(review.changedEntryIds).toEqual(['stay', 'transfer']);
  expect(review.budget).toEqual({ before: { knownMinor: 430000, unknownEntryIds: [], withinBudget: true },
    after: { knownMinor: 750000, unknownEntryIds: [], withinBudget: true } });
});

test('unknown costs and exclusions never become a claim of zero cost or budget success', () => {
  const row = attempt('unknown-cost');
  row.evidence.after.exclusions = ['交通待確認'];
  const review = buildReviewPacket(report([row])).cases.find(c => c.caseId === row.caseId)!;
  expect(review.budget?.after).toEqual({ knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null });
  expect(review.exclusions?.after).toEqual(['交通待確認']);
});

test('missing, failed, skipped and durable records stay explicit without inflating attempts', () => {
  const packet = buildReviewPacket(report([
    { round: 1, caseId: 'non-diver', outcome: 'failed', reason: 'EVAL_RATE_LIMIT', costMicros: null },
    durable(), { round: 1, caseId: 'ambiguous', outcome: 'skipped', reason: 'STOP' },
    durable('no-date'),
  ]));
  expect(packet.coverage).toMatchObject({ recordedCases: 2, attemptedCases: 1, completedCases: 0,
    failedCases: 1, skippedCases: 1, missingCases: 28, durableAuditRecords: 2, complete: false });
  expect(packet.cases.find(c => c.caseId === 'non-diver')).toMatchObject({ outcome: 'failed',
    reason: 'EVAL_RATE_LIMIT', runId: null, inputDigest: null, budget: null, originalGrade: null,
    requirementDiffs: null, changedEntryIds: null, modelProse: 'Partial answer', eventSource: 'durable-audit' });
  expect(packet.cases.find(c => c.caseId === 'no-date')).toMatchObject({ outcome: 'missing', reason: 'MISSING_ATTEMPT' });
});

test('full 3×10 coverage and passed source grades still cannot approve human review', () => {
  const records = [1, 2, 3].flatMap(round => cases.flatMap(c => {
    const row = attempt(c.id, round); row.grade = { pass: true, reasons: [], safetyFailures: [] };
    return [row, durable(c.id, round)];
  }));
  const packet = buildReviewPacket(report(records));
  expect(packet.coverage).toMatchObject({ expectedCases: 30, attemptedCases: 30, recordedCases: 30,
    durableAuditRecords: 30, missingCases: 0, complete: true, allCasesAttempted: true });
  expect(packet.cases.every(c => c.textReview === 'pending')).toBe(true);
  expect(packet.evaluationGatePassed).toBe(false);
});

test.each([
  [attempt(), attempt()],
  [durable(), durable()],
  [{ ...attempt(), caseId: 'surprise' }],
  [{ ...durable(), caseId: 'surprise' }],
  [{ ...attempt(), round: 4 }],
  [{ ...attempt(), outcome: 'approved' }],
  [{ ...attempt(), outcome: 'skipped' }],
  [{ ...durable(), outcome: 'completed' }],
  [{ round: 1, caseId: 'non-diver', outcome: 'completed' }],
])('rejects duplicate, unexpected or malformed records %#', (...records) => {
  expect(() => buildReviewPacket(report(records))).toThrow();
});

test('validates snapshot, event and identity before rendering review data', () => {
  const row = attempt(); row.evidence.after.requirements.people = 7;
  expect(() => buildReviewPacket(report([row]))).toThrow();
  const mismatch = attempt(); mismatch.evidence.caseId = 'ambiguous';
  expect(() => buildReviewPacket(report([mismatch]))).toThrow('EVIDENCE_CASE_MISMATCH');
  const invalidEvent = { ...attempt(), events: [{ type: 'TEXT_MESSAGE_CONTENT', delta: 42 }] };
  expect(() => buildReviewPacket(report([invalidEvent]))).toThrow();
  expect(() => buildReviewPacket(null)).toThrow();
});

test('failed collected evidence remains failed and reorder is explicit without false entry mutations', () => {
  const row = attempt('no-date'); row.outcome = 'failed'; row.evidence.runStatus = 'failed';
  row.evidence.after.entries.reverse();
  const review = buildReviewPacket(report([row])).cases.find(c => c.caseId === row.caseId)!;
  expect(review).toMatchObject({ outcome: 'failed', runStatus: 'failed', entryOrderChanged: true, changedEntryIds: [] });
});

const acceptedRunId = '00000000-0000-4000-8000-000000000011';
function currentReport() {
  const row = attempt('ambiguous');
  return { ...report(), schemaVersion: 2, records: [{ ...row, schemaVersion: 2,
    evidence: { ...row.evidence, runId: acceptedRunId, toolCount: 1, visibleToolCount: 0 },
    events: [{ type: 'CUSTOM', name: ANSWER_EVENT_NAME, value: {
      schemaVersion: 1, templateVersion: 1, answerId: `ans_${'a'.repeat(64)}`, runId: acceptedRunId,
      evidenceRefs: [] as string[], body: { kind: 'clarify', fields: ['people'] },
    } }],
  }] };
}

test('v2 review exposes only AcceptedAnswer and keeps independent semantic review pending', () => {
  const source = currentReport(), original = structuredClone(source);
  source.records[0].grade = { pass: true, reasons: [], safetyFailures: [] };
  const packet = buildAcceptedReviewPacket(source), row = packet.cases[0];
  expect(packet).toMatchObject({ schemaVersion: 2, mode: 'accepted-answer-review',
    textReview: 'pending', taskReview: 'pending', evaluationGatePassed: false });
  expect(row).toMatchObject({ acceptedAnswers: [source.records[0].events[0].value],
    observedTerminal: null, textReview: 'pending', taskReview: 'pending',
    answerValidation: { privateEvidenceProvenance: 'not-verified', phaseCompletion: 'not-verified', productReceipt: 'not-verified' } });
  expect(row).not.toHaveProperty('modelProse');
  row.acceptedAnswers![0].body = { kind: 'unsupported', reason: 'booking' };
  expect(source.records[0].events).toEqual(original.records[0].events);
});

test('historical reports are isolated v1 read-only; no implicit upgrade or mixed records', () => {
  expect(buildReviewPacket(report())).toMatchObject({ schemaVersion: 1, mode: 'historical-v1-read-only',
    evaluationGatePassed: false, textReview: 'pending' });
  expect(buildReviewPacket({ ...report(), schemaVersion: 1 })).toMatchObject({ schemaVersion: 1 });
  for (const source of [report(), { ...report(), schemaVersion: 1 }, { ...report(), schemaVersion: 2 },
    { ...currentReport(), schemaVersion: 3 }]) expect(() => buildAcceptedReviewPacket(source)).toThrow();
  expect(() => buildReviewPacket(currentReport())).toThrow();
  expect(() => buildReviewPacket({ ...currentReport(), schemaVersion: 1 })).toThrow();
  const source = currentReport();
  expect(() => buildAcceptedReviewPacket({ ...source, records: [...source.records, attempt()] })).toThrow();
});

test.each(['run', 'version', 'template', 'refs', 'private', 'missing', 'raw', 'conflicting-id'])('v2 review rejects %s answer evidence', mode => {
  const source = currentReport(), row = source.records[0], value = row.events[0].value;
  if (mode === 'run') value.runId = '00000000-0000-4000-8000-000000000099';
  if (mode === 'version') value.schemaVersion = 2;
  if (mode === 'template') value.templateVersion = 2;
  if (mode === 'refs') value.evidenceRefs.push(`ev_${'b'.repeat(64)}`);
  if (mode === 'private') Object.assign(value, { ownerId: 'private' });
  if (mode === 'missing') row.events = [];
  if (mode === 'raw') Object.assign(row.events[0], { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'old prose' });
  if (mode === 'conflicting-id') row.events.push({ ...row.events[0], value: { ...value, body: { kind: 'clarify', fields: ['dates'] } } });
  expect(() => buildAcceptedReviewPacket(source)).toThrow();
});

test('failed v2 audit can retain bound answers but never become a completed attempt', () => {
  const source = currentReport(), answer = source.records[0].events[0];
  const audit = { round: 1, caseId: 'ambiguous', kind: 'durable-audit', chargedMicros: 12,
    runs: [{ id: acceptedRunId, status: 'failed', proposal_id: null, interrupt_id: null, decision: null }],
    events: [{ run_id: acceptedRunId, sequence: 0, event: answer }] };
  const failed = { round: 1, caseId: 'ambiguous', outcome: 'failed', reason: 'EVAL_EXCEPTION', costMicros: null };
  const row = buildAcceptedReviewPacket({ ...source, records: [failed, audit] }).cases[0];
  expect(row).toMatchObject({ outcome: 'failed', originalGrade: null, acceptedAnswers: [answer.value], taskReview: 'pending' });
  expect(() => buildAcceptedReviewPacket({ ...source, records: [failed,
    { ...audit, events: [{ ...audit.events[0], run_id: '00000000-0000-4000-8000-000000000099' }] }] })).toThrow();
  const changed = structuredClone(audit);
  changed.events[0].event.value.body.fields = ['dates'];
  expect(() => buildAcceptedReviewPacket({ ...source, records: [...source.records, changed] }))
    .toThrow('EVAL_REVIEW_ANSWER_MISMATCH');
  expect(() => buildAcceptedReviewPacket({ ...source, records: [...source.records,
    { ...audit, events: [...audit.events, ...audit.events] }] })).toThrow('EVAL_REVIEW_EVENT_SEQUENCE');
});

test('review preserves unknown native tool count separately from visible progress events', () => {
  const source = currentReport(), row = source.records[0];
  const packet = buildAcceptedReviewPacket({ ...source, records: [{ ...row,
    evidence: { ...row.evidence, toolCount: null, visibleToolCount: 0 } }] });
  expect(packet.cases[0]).toMatchObject({ toolUsage: { nativeToolCount: null, visibleToolCount: 0 }, textReview: 'pending' });
  expect(packet.evaluationGatePassed).toBe(false);
});

test('a supplied passing grade and idempotent answer redelivery cannot certify a later phase or product receipt', () => {
  const source = currentReport(), row = source.records[0];
  row.grade = { pass: true, reasons: [], safetyFailures: [] };
  row.events.push(structuredClone(row.events[0]));
  Object.assign(row.evidence, { phaseCompletion: 'checked', productReceipt: 'checked' });
  const packet = buildAcceptedReviewPacket(source);
  expect(packet.cases[0].answerValidation).toMatchObject({ schemaAndRunBinding: 'checked',
    phaseCompletion: 'not-verified', productReceipt: 'not-verified' });
  expect(packet.cases[0].taskReview).toBe('pending');
  expect(packet.evaluationGatePassed).toBe(false);
});
