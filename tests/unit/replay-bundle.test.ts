import { EventType } from '@ag-ui/core';
import { HttpAgent } from '@ag-ui/client';
import { describe, expect, test } from 'vitest';
import { collectCase, type CollectorPorts, type UsageAudit } from '../../evals/collector';
import { evaluationInput } from '../../evals/fixtures';
import { createEvidenceReplay, parseAcceptedAnswers, parseHistoricalReplayBundle, parseReplayBundle, type ReplayBundle } from '../../evals/replay-bundle';
import { buildProposal } from '../../src/domain/proposal';
import { calculateBudget } from '../../src/domain/budget';
import { reviewProposal } from '../../src/server/proposal-review';
import { ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { proposalEvidence, receiptEvidence, toolEvidence, type ValidationEvidence } from '../../src/agent/answer-evidence';

// Synthetic public HTTP projections for offline tests ONLY. Never exported as
// campaign artifacts or evidence of live model quality. No DB/ADK/provider.
const tripId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const proposalId = '00000000-0000-4000-8000-000000000003';
function fixture(accept = true): ReplayBundle {
  const input = evaluationInput(accept ? 'free-afternoon' : 'ambiguous');
  const initial = { id: tripId, version: 1, snapshot: input.before, budget: calculateBudget(input.before) };
  const draft = buildProposal(input.before, [{ kind: 'remove', entryId: 'transfer' }], input.catalog, 'agent');
  const binding = { ownerId: tripId, tripId, runId, baseVersion: 1 };
  const validation = toolEvidence(binding, input.before, input.catalog, { id: 'validation', name: 'validate_changes',
    args: { changes: [{ kind: 'remove', entryId: 'transfer' }] },
    result: { ...draft, validationId: proposalId } }) as ValidationEvidence;
  const proposal = proposalEvidence(validation, 'proposal');
  const receipt = receiptEvidence(binding, 'receipt', { status: 'applied', version: 2 });
  const answer = compileAnswer({ version: '1', answer: accept ? { kind: 'proposal', evidenceRef: proposal.id }
    : { kind: 'clarify', fields: ['people'] } }, { binding, eventId: 'start', evidence: [validation, proposal] });
  const startEvents = [
    { type: EventType.RUN_STARTED, threadId: tripId, runId: 'start-id' },
    { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer },
    { type: EventType.RUN_FINISHED, threadId: tripId, runId: 'start-id' },
  ];
  const resumeEvents = accept ? [
    { type: EventType.RUN_STARTED, threadId: tripId, runId: 'resume-id' },
    { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME,
      value: compileAnswer({ version: '1', answer: { kind: 'receipt', evidenceRef: receipt.id } },
        { binding, eventId: 'resume', evidence: [receipt] }) },
    { type: EventType.RUN_FINISHED, threadId: tripId, runId: 'resume-id' },
  ] : [];
  const run = { id: runId, tripId, requestId: 'start-id', baseVersion: 1, message: input.prompt, answerContractVersion: 1,
    status: accept ? 'awaiting_confirmation' as const : 'succeeded' as const,
    proposalId: accept ? proposalId : null, interruptId: accept ? 'interrupt-1' : null, decision: null,
    events: startEvents.map((event, sequence) => ({ sequence, event })),
    ...(accept ? { proposal: { draft, base: initial } } : {}),
  };
  return parseReplayBundle({ schemaVersion: 2, caseId: input.caseId, inputDigest: input.digest, model: 'synthetic-unit-only',
    decisionReceipt: accept ? { runId, status: 'applied', version: 2 } : null,
    prompt: input.prompt, catalog: input.catalog, startEvents, resumeEvents,
    initial: { trip: initial, runs: { runs: [] } },
    afterStart: { trip: initial, runs: { runs: [run] } },
    final: { trip: accept ? { ...initial, version: 2, snapshot: draft.next, budget: draft.budget } : initial,
      runs: { runs: [{ ...run, status: 'succeeded', decision: accept ? true : null,
        events: [...startEvents, ...resumeEvents].map((event, sequence) => ({ sequence, event })) }] } },
  });
}
function start(b: ReplayBundle) {
  return { threadId: tripId, runId: 'browser-start', messages: [{ id: 'browser-message', role: 'user', content: b.prompt }],
    forwardedProps: { baseVersion: 1 }, state: {}, tools: [], context: [] };
}
function resume() {
  return { threadId: tripId, runId: 'browser-resume', messages: [], forwardedProps: { runId },
    resume: [{ interruptId: 'interrupt-1', status: 'resolved', payload: { confirmed: true } }], state: {}, tools: [], context: [] };
}
const path = `/api/trips/${tripId}`;

test('server review projections preserve old bundles and reject changed differences or cost', () => {
  const historical = fixture(), original = JSON.stringify(historical);
  const replay = createEvidenceReplay(historical);
  replay.respond('POST', `${path}/agent`, start(historical));
  const projection = replay.respond('GET', `${path}/runs`).json as ReplayBundle['afterStart']['runs'];
  const proposal = projection.runs[0].proposal!;
  expect(proposal.review).toEqual(reviewProposal(proposal.base.snapshot, proposal.draft));
  expect(JSON.stringify(historical)).toBe(original);
  const current = structuredClone(historical);
  for (const checkpoint of [current.afterStart, current.final]) {
    const run = checkpoint.runs.runs[0]; run.executor = 'temporal-v1';
    run.proposal!.review = JSON.parse(JSON.stringify(reviewProposal(run.proposal!.base.snapshot, run.proposal!.draft)));
  }
  expect(parseReplayBundle(current)).toEqual(current);
  const wrongCost = structuredClone(current);
  wrongCost.afterStart.runs.runs[0].proposal!.review!.knownDeltaMinor++;
  expect(() => parseReplayBundle(wrongCost)).toThrow('REPLAY_PROPOSAL_REVIEW_MISMATCH');
  const wrongPath = structuredClone(current);
  wrongPath.afterStart.runs.runs[0].proposal!.review!.differences[0].path = '/entries/stay';
  expect(() => parseReplayBundle(wrongPath)).toThrow('REPLAY_PROPOSAL_REVIEW_MISMATCH');
});

test('replay uses actual checkpoints across refresh and only recorded acceptance', () => {
  const b = fixture(), replay = createEvidenceReplay(b);
  expect(replay.respond('GET', path).json).toEqual(b.initial.trip);
  const sent = replay.respond('POST', `${path}/agent`, start(b));
  expect(sent.sse).toContain('browser-start');
  expect(sent.sse).toContain(ANSWER_EVENT_NAME);
  expect(sent.sse).not.toContain('TEXT_MESSAGE');
  expect(replay.respond('GET', `${path}/runs`).json).toMatchObject({ runs: [{ id: runId,
    requestId: 'browser-start', proposal: b.afterStart.runs.runs[0].proposal,
    events: [{ sequence: 0, event: { type: EventType.RUN_STARTED, runId: 'browser-start' } },
      ...b.afterStart.runs.runs[0].events.slice(1, -1),
      { sequence: 2, event: { type: EventType.RUN_FINISHED, runId: 'browser-start' } }] }] });
  expect(replay.respond('GET', path).json).toEqual(b.initial.trip);
  expect(replay.posts).toBe(1);
  replay.respond('POST', `${path}/agent`, resume());
  expect(replay.respond('GET', path).json).toEqual(b.final.trip);
  expect(replay.respond('GET', `${path}/runs`).json).toMatchObject({ runs: [{ id: runId,
    requestId: 'browser-start', status: 'succeeded', decision: true,
    events: expect.arrayContaining([{ sequence: 3, event: { type: EventType.RUN_STARTED,
      threadId: tripId, runId: 'browser-resume' } }]) }] });
  expect(replay.posts).toBe(2);
  expect(() => replay.respond('POST', `${path}/agent`, resume())).toThrow();
  expect(b.startEvents[0]).toHaveProperty('runId', 'start-id');
});

test('readonly evidence cannot invent confirmation or version changes', () => {
  const b = fixture(false), replay = createEvidenceReplay(b);
  replay.respond('POST', `${path}/agent`, start(b));
  expect(replay.respond('GET', path).json).toEqual(b.initial.trip);
  expect(() => replay.respond('POST', `${path}/agent`, resume())).toThrow('REPLAY_UNEXPECTED_DISPATCH');
});

test('real HttpAgent client consumes replay SSE and reconciles browser request IDs without network', async () => {
  const b = fixture(), replay = createEvidenceReplay(b);
  const fakeFetch: typeof fetch = async (_url, init) => {
    const result = replay.respond('POST', `${path}/agent`, JSON.parse(String(init?.body)));
    return new Response(result.sse, { status: result.status, headers: { 'content-type': 'text/event-stream' } });
  };
  const agent = new HttpAgent({ url: `http://offline.invalid${path}/agent`, threadId: tripId, initialState: {},
    initialMessages: [{ id: 'browser-start', role: 'user', content: b.prompt }], fetch: fakeFetch });
  await agent.runAgent({ runId: 'browser-start', tools: [], context: [], forwardedProps: { baseVersion: 1 } });
  expect(replay.respond('GET', `${path}/runs`).json).toMatchObject({ runs: [{ requestId: 'browser-start' }] });
  const next = new HttpAgent({ url: `http://offline.invalid${path}/agent`, threadId: tripId,
    initialState: {}, initialMessages: [], fetch: fakeFetch });
  await next.runAgent({ runId: 'browser-resume', tools: [], context: [], forwardedProps: { runId },
    resume: [{ interruptId: 'interrupt-1', status: 'resolved', payload: { confirmed: true } }] });
  expect(replay.phase).toBe('final');
  expect(next.messages).toEqual([]); // The new UI consumes CUSTOM, never assistant prose.
  expect(replay.respond('GET', `${path}/runs`).json).toMatchObject({ runs: [{ events: expect.arrayContaining([
    { sequence: 4, event: { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME,
      value: expect.objectContaining({ runId, body: { kind: 'receipt', status: 'applied', version: 2 } }) } },
  ]) }] });
});

test('unknown API, unrelated mutations, wrong prompt and rejection fail closed', () => {
  const b = fixture(), replay = createEvidenceReplay(b);
  for (const [method, url] of [['GET', '/api/secret'], ['POST', `${path}/apply`], ['DELETE', path], ['GET', `${path}?x=1`]]) {
    expect(() => replay.respond(method, url)).toThrow('REPLAY_UNEXPECTED_REQUEST');
  }
  expect(() => replay.respond('POST', `${path}/agent`, { ...start(b), messages: [{ role: 'user', content: 'different' }] })).toThrow();
  expect(() => replay.respond('POST', `${path}/agent`, resume())).toThrow();
  expect(replay.phase).toBe('initial');
  replay.respond('POST', `${path}/agent`, start(b));
  expect(() => replay.respond('POST', `${path}/agent`, { ...resume(), resume: [{ interruptId: 'interrupt-1',
    status: 'resolved', payload: { confirmed: false } }] })).toThrow();
  expect(replay.posts).toBe(1);
});

describe('strict evidence validation', () => {
  test.each(['cookie', 'privateUsage', 'accountId', 'loadCredential'])('rejects private envelope %s', key => {
    expect(() => parseReplayBundle({ ...fixture(), [key]: 'not-for-export' })).toThrow();
  });
  test('rejects private nested run fields and raw model event payload', () => {
    const b = fixture();
    expect(() => parseReplayBundle({ ...b, afterStart: { ...b.afterStart,
      runs: { runs: [{ ...b.afterStart.runs.runs[0], ownerId: 'private' }] } } })).toThrow();
    const withRaw = structuredClone(b);
    Object.assign(withRaw.startEvents[0], { rawEvent: { usage: 'private' } });
    expect(() => parseReplayBundle(withRaw)).toThrow();
    expect(() => parseReplayBundle({ ...b, startEvents: [{ type: EventType.CUSTOM,
      name: 'private-accounting', value: { tokens: 1 } }, ...b.startEvents] })).toThrow();
  });
  test('rejects missing proposal, forged saved text, cross-trip and early mutation', () => {
    const mutations: ((b: ReplayBundle) => void)[] = [
      b => { delete b.afterStart.runs.runs[0].proposal; },
      b => { b.final.runs.runs[0].events.pop(); },
      b => { b.final.trip.id = runId; },
      b => { b.afterStart.trip.version = 2; },
      b => { b.final.trip.snapshot = b.initial.trip.snapshot; },
      b => { b.final.runs.runs[0].decision = false; },
      b => { b.afterStart.runs.runs[0].events[1].sequence = 0; },
    ];
    for (const mutate of mutations) { const b = fixture(); mutate(b); expect(() => parseReplayBundle(b)).toThrow(); }
  });
  test('returns detached data and rejects oversized bundle', () => {
    const b = fixture(), parsed = parseReplayBundle(b);
    parsed.initial.trip.snapshot.requirements.pace = 'relaxed';
    expect(b.initial.trip.snapshot.requirements.pace).toBe('balanced');
    expect(() => parseReplayBundle({ ...b, extra: 'x'.repeat(4 * 1024 * 1024) })).toThrow('REPLAY_TOO_LARGE');
  });
});

async function collect(capture: boolean, accept = true, mutate?: (bundle: ReplayBundle) => void,
  mutateDurable?: (runs: ReplayBundle['final']['runs']) => void, auditPatch?: Partial<UsageAudit>) {
  const b = fixture(accept);
  mutate?.(b);
  let phase: 'initial' | 'afterStart' | 'final' = 'initial';
  const requests: string[] = [];
  let captured: ReplayBundle | undefined;
  const ports: CollectorPorts = {
    model: b.model, faultSupported: true, setup: async () => structuredClone(b.initial.trip),
    audit: async () => ({ model: b.model, runId, complete: true, modelCalls: accept ? 2 : 1,
      nativeToolCalls: accept ? 2 : 1, decisionReceipt: b.decisionReceipt, costMicros: 10, ...auditPatch }),
    ...(capture ? { captureReplay: (value: ReplayBundle) => { captured = value; } } : {}),
    request: async (url, body) => {
      requests.push(`${body === undefined ? 'GET' : 'POST'} ${url}`);
      if (url === `${path}/agent`) {
        const request = body as { runId: string };
        const events = phase === 'initial' ? b.startEvents : b.resumeEvents;
        if (phase === 'initial') {
          b.afterStart.runs.runs[0].requestId = request.runId;
          b.final.runs.runs[0].requestId = request.runId;
        }
        // Public stream and saved projection contain exactly the same events.
        for (const e of events) if ('runId' in e) e.runId = request.runId;
        b.afterStart.runs.runs[0].events = b.startEvents.map((event, sequence) => ({ sequence, event }));
        b.final.runs.runs[0].events = [...b.startEvents, ...b.resumeEvents].map((event, sequence) => ({ sequence, event }));
        phase = phase === 'initial' ? 'afterStart' : 'final';
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === path) return Response.json(b[phase].trip);
      if (url === `${path}/runs`) {
        const runs = structuredClone(b[phase].runs);
        mutateDurable?.(runs);
        return Response.json(runs);
      }
      throw new Error('UNEXPECTED_TEST_REQUEST');
    },
  };
  const result = await collectCase(b.caseId, ports);
  return { result, requests, captured };
}

test('optional collector captures complete detached checkpoints with no extra dispatch', async () => {
  const plain = await collect(false), recorded = await collect(true);
  expect(plain.captured).toBeUndefined();
  expect(recorded.requests.slice(1)).toEqual(plain.requests);
  expect(recorded.requests[0]).toBe(`GET ${path}/runs`);
  expect(recorded.requests.filter(r => r.startsWith('POST'))).toHaveLength(2);
  expect(recorded.captured?.afterStart.runs.runs[0].proposal?.draft.canApply).toBe(true);
  expect(recorded.captured?.resumeEvents.length).toBeGreaterThan(0);
  expect(recorded.result.evidence).toEqual({ ...plain.result.evidence, latencyMs: recorded.result.evidence.latencyMs });
  expect(recorded.result.grade).toEqual(plain.result.grade);
  expect(recorded.result.schemaVersion).toBe(2);
  expect(recorded.captured?.schemaVersion).toBe(2);
  expect(recorded.result.evidence.textReview).toBe('pending');
  expect(recorded.result.grade.pass).toBe(false);
  recorded.captured!.final.trip.version = 99;
  expect(recorded.result.evidence.afterVersion).toBe(2);
});

test('collector preserves readonly outcomes and does not make a resume for capture', async () => {
  const { captured, requests, result } = await collect(true, false);
  expect(requests.filter(r => r.startsWith('POST'))).toHaveLength(1);
  expect(captured?.resumeEvents).toEqual([]);
  expect(captured?.afterStart).toEqual(captured?.final);
  expect(result.evidence.decision).toBe('none');
});

function answer(bundle: ReplayBundle, resume = false): AcceptedAnswer {
  const event = (resume ? bundle.resumeEvents : bundle.startEvents).find(event => event.type === EventType.CUSTOM);
  if (event?.type !== EventType.CUSTOM) throw new Error('TEST_ANSWER_MISSING');
  return event.value as AcceptedAnswer;
}
function syncDurable(bundle: ReplayBundle) {
  bundle.afterStart.runs.runs[0].events = bundle.startEvents.map((event, sequence) => ({ sequence, event }));
  bundle.final.runs.runs[0].events = [...bundle.startEvents, ...bundle.resumeEvents].map((event, sequence) => ({ sequence, event }));
}

test('v1 raw replay remains detached history and cannot enter v2 core playback or be relabeled', () => {
  const b = fixture(false);
  b.startEvents[1] = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'old', delta: '歷史錯誤：TWD330' };
  syncDurable(b);
  const legacyCheckpoint = (checkpoint: ReplayBundle['afterStart']) => ({ ...checkpoint,
    runs: { runs: checkpoint.runs.runs.map(run => {
      const copy = { ...run }; Reflect.deleteProperty(copy, 'answerContractVersion'); return copy;
    }) } });
  const historical = { ...b, schemaVersion: 1,
    afterStart: legacyCheckpoint(b.afterStart), final: legacyCheckpoint(b.final) };
  Reflect.deleteProperty(historical, 'decisionReceipt');
  const original = structuredClone(historical), parsed = parseHistoricalReplayBundle(historical);
  expect(parsed).toEqual(original);
  expect(parsed.startEvents[1]).toMatchObject({ delta: '歷史錯誤：TWD330' });
  expect(() => parseReplayBundle(historical)).toThrow();
  expect(() => createEvidenceReplay(historical)).toThrow();
  expect(() => parseReplayBundle({ ...historical, schemaVersion: 2 })).toThrow();
  expect(() => parseHistoricalReplayBundle(fixture(false))).toThrow();
  expect(() => parseReplayBundle({ ...fixture(false), schemaVersion: 3 })).toThrow();
  parsed.model = 'inspection-copy';
  expect(historical).toEqual(original);
});

test.each(['run', 'transport-run', 'schema', 'template', 'name', 'refs', 'proposal-ref', 'price', 'private', 'raw', 'tool-raw', 'missing'])(
  'v2 replay rejects %s even when durable and streamed payloads agree', mode => {
  const b = fixture(), value = answer(b);
  if (mode === 'run') value.runId = tripId;
  if (mode === 'transport-run') value.runId = b.afterStart.runs.runs[0].requestId;
  if (mode === 'schema') Object.assign(value, { schemaVersion: 2 });
  if (mode === 'template') Object.assign(value, { templateVersion: 2 });
  if (mode === 'name') Object.assign(b.startEvents[1], { name: 'dive_trip.answer.v2' });
  if (mode === 'refs') value.evidenceRefs.push(value.evidenceRefs[0]);
  if (mode === 'proposal-ref') value.evidenceRefs[0] = `ev_${'f'.repeat(64)}`;
  if (mode === 'price' && value.body.kind === 'proposal') value.body.budget.known.display = 'TWD 330.00';
  if (mode === 'private') Object.assign(value, { rawText: 'unverified answer' });
  if (mode === 'raw') b.startEvents.splice(1, 0, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'unverified answer' });
  if (mode === 'tool-raw') b.startEvents.splice(1, 0, { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 't', content: 'unverified tool text' });
  if (mode === 'missing') b.startEvents.splice(1, 1);
  syncDurable(b);
  expect(() => parseReplayBundle(b)).toThrow();
});

test('answer IDs are immutable across start/resume; identical delivery is idempotent', () => {
  const b = fixture();
  expect(parseAcceptedAnswers([b.startEvents[1], structuredClone(b.startEvents[1])], runId)).toEqual([answer(b)]);
  answer(b, true).answerId = answer(b).answerId;
  syncDurable(b);
  expect(() => parseReplayBundle(b)).toThrow('EVAL_ANSWER_ID_CONFLICT');
});

const phaseTamperModes = ['old-proposal-id', 'fresh-proposal-in-resume', 'receipt-version', 'receipt-decision',
  'missing-product-receipt', 'product-receipt-version', 'product-receipt-run', 'multiple-terminal-answers',
  'awaiting-with-clarification', 'pending-version', 'lifecycle-status'] as const;
function tamperPhase(b: ReplayBundle, mode: typeof phaseTamperModes[number]) {
  if (mode === 'old-proposal-id' || mode === 'fresh-proposal-in-resume') {
    b.resumeEvents[1] = structuredClone(b.startEvents[1]);
    if (mode === 'fresh-proposal-in-resume') answer(b, true).answerId = `ans_${'e'.repeat(64)}`;
  }
  if (mode === 'receipt-version') answer(b, true).body = { kind: 'receipt', status: 'applied', version: 999 };
  if (mode === 'receipt-decision') answer(b, true).body = { kind: 'receipt', status: 'rejected', version: 2 };
  if (mode === 'missing-product-receipt') b.decisionReceipt = null;
  if (mode === 'product-receipt-version') b.decisionReceipt!.version = 999;
  if (mode === 'product-receipt-run') b.decisionReceipt!.runId = tripId;
  if (mode === 'multiple-terminal-answers') {
    const extra = structuredClone(b.resumeEvents[1]);
    if (extra.type === EventType.CUSTOM) extra.value.answerId = `ans_${'e'.repeat(64)}`;
    b.resumeEvents.splice(2, 0, extra);
  }
  if (mode === 'awaiting-with-clarification') {
    answer(b).body = { kind: 'clarify', fields: ['people'] }; answer(b).evidenceRefs = [];
  }
  if (mode === 'pending-version' && answer(b).body.kind === 'proposal') {
    const body = answer(b).body;
    if (body.kind === 'proposal') body.budget.baseVersion = 999;
  }
  if (mode === 'lifecycle-status') b.final.runs.runs[0].status = 'failed';
  syncDurable(b);
}

test.each(phaseTamperModes)('replay and collector without capture reject phase mismatch %s despite matching durable events', async mode => {
  const b = fixture(); tamperPhase(b, mode);
  expect(() => parseReplayBundle(b)).toThrow();
  await expect(collect(false, true, bundle => tamperPhase(bundle, mode))).rejects.toThrow();
});

test.each(['version', 'decision', 'missing'] as const)('failure.committed must match the independent product receipt: %s', async mode => {
  const mutate = (b: ReplayBundle) => {
    answer(b, true).body = { kind: 'failure', reason: 'incomplete-run', committed: mode === 'missing' ? null
      : { status: mode === 'decision' ? 'rejected' : 'applied', version: mode === 'version' ? 999 : 2 } };
    if (mode === 'missing') answer(b, true).evidenceRefs = [];
    b.resumeEvents[b.resumeEvents.length - 1] = { type: EventType.RUN_ERROR, message: '執行未完整完成' };
    b.final.runs.runs[0].status = 'failed'; syncDurable(b);
  };
  const b = fixture(); mutate(b);
  expect(() => parseReplayBundle(b)).toThrow();
  await expect(collect(false, true, mutate)).rejects.toThrow();
});

test('a failed resume before product commit preserves null receipt and unchanged trip, never success', async () => {
  const mutate = (b: ReplayBundle) => {
    answer(b, true).body = { kind: 'failure', reason: 'incomplete-run', committed: null };
    answer(b, true).evidenceRefs = [];
    b.decisionReceipt = null;
    b.final.trip = structuredClone(b.initial.trip);
    b.final.runs.runs[0].status = 'failed';
    b.resumeEvents[b.resumeEvents.length - 1] = { type: EventType.RUN_ERROR, message: '執行未完整完成' };
    syncDurable(b);
  };
  const b = fixture(); mutate(b);
  expect(parseReplayBundle(b).decisionReceipt).toBeNull();
  const { result } = await collect(false, true, mutate);
  expect(result.grade.pass).toBe(false);
  expect(result.grade.reasons).toContain('ANSWER_INCOMPLETE');
  expect(result.evidence).toMatchObject({ runStatus: 'failed', afterVersion: 1 });
});

test('committed data and a failed answer/run survive replay as separate facts', () => {
  const b = fixture();
  answer(b, true).body = { kind: 'failure', reason: 'incomplete-run', committed: { status: 'applied', version: 2 } };
  b.resumeEvents[b.resumeEvents.length - 1] = { type: EventType.RUN_ERROR, message: '執行未完整完成' };
  b.final.runs.runs[0].status = 'failed';
  syncDurable(b);
  const replay = createEvidenceReplay(b);
  replay.respond('POST', `${path}/agent`, start(b));
  const sent = replay.respond('POST', `${path}/agent`, resume());
  expect(sent.sse).toContain('incomplete-run');
  expect(replay.respond('GET', path).json).toMatchObject({ version: 2 });
  expect(replay.respond('GET', `${path}/runs`).json).toMatchObject({ runs: [{ status: 'failed', decision: true }] });
});

test.each(['foreign-run', 'raw', 'missing', 'version', 'trip', 'id-conflict'])(
  'collector enforces %s without opting into replay capture', async mode => {
  await expect(collect(false, mode === 'id-conflict', b => {
    if (mode === 'foreign-run') answer(b).runId = tripId;
    if (mode === 'raw') b.startEvents[1] = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'old answer' };
    if (mode === 'missing') b.startEvents.splice(1, 1);
    if (mode === 'version') Object.assign(answer(b), { schemaVersion: 2 });
    if (mode === 'trip') Object.assign(b.startEvents[0], { threadId: runId });
    if (mode === 'id-conflict') answer(b, true).answerId = answer(b).answerId;
  })).rejects.toThrow();
});

test.each(['content', 'sequence', 'run-trip', 'run-version', 'resume-run', 'legacy-contract'])(
  'collector compares %s with durable run evidence without capture', async mode => {
  await expect(collect(false, mode === 'resume-run', undefined, runs => {
    const run = runs.runs[0];
    if (mode === 'content') {
      const event = run.events.find(row => row.event.type === EventType.CUSTOM)!.event;
      if (event.type === EventType.CUSTOM) event.value.body = { kind: 'clarify', fields: ['dates'] };
    }
    if (mode === 'sequence') run.events[1].sequence = run.events[0].sequence;
    if (mode === 'run-trip') run.tripId = runId;
    if (mode === 'run-version') run.baseVersion = 2;
    if (mode === 'legacy-contract') Object.assign(run, { answerContractVersion: 0 });
    if (mode === 'resume-run' && run.decision === true) run.id = tripId;
  })).rejects.toThrow();
});

test('a safe failure answer cannot count as task success', async () => {
  const { result } = await collect(false, false, b => {
    answer(b).body = { kind: 'failure', reason: 'invalid-answer', committed: null };
    b.startEvents[b.startEvents.length - 1] = { type: EventType.RUN_ERROR, message: '執行未完整完成' };
    b.afterStart.runs.runs[0].status = 'failed';
    b.final.runs.runs[0].status = 'failed';
  });
  expect(result.evidence).toMatchObject({ runStatus: 'failed', textReview: 'pending' });
  expect(result.grade.pass).toBe(false);
  expect(result.grade.reasons).toEqual(expect.arrayContaining(['RUN_NOT_SUCCEEDED', 'ANSWER_INCOMPLETE', 'TEXT_REVIEW_REQUIRED']));
});

test('collector uses complete private native counts including invisible final tools', async () => {
  const { result } = await collect(false, false, undefined, undefined, { nativeToolCalls: 6 });
  expect(result.evidence).toMatchObject({ toolCount: 6, visibleToolCount: 0, textReview: 'pending' });
  expect(result.grade.safetyFailures).not.toContain('EXECUTION_LIMIT_INVALID');
  const exceeded = await collect(false, false, undefined, undefined, { nativeToolCalls: 7 });
  expect(exceeded.result.grade.safetyFailures).toContain('EXECUTION_LIMIT_INVALID');
  const unknown = await collect(false, false, undefined, undefined, { nativeToolCalls: undefined });
  expect(unknown.result.evidence).toMatchObject({ toolCount: null, visibleToolCount: 0 });
  expect(unknown.result.grade.safetyFailures).toContain('TOOL_USAGE_EVIDENCE_MISSING');
});

test('fault observation comes only from the same run private audit', async () => {
  const caseInput = (b: ReplayBundle) => { b.caseId = 'lookup-timeout'; };
  const bound = await collect(false, false, caseInput, undefined, { faultObserved: 'catalog-timeout' });
  expect(bound.result.evidence.faultObserved).toBe('catalog-timeout');
  const absent = await collect(false, false, caseInput);
  expect(absent.result.evidence.faultObserved).toBeNull();
  expect(absent.result.grade.reasons).toContain('FAULT_EVIDENCE_MISMATCH');
  const foreign = await collect(false, false, caseInput, undefined, { runId: tripId, faultObserved: 'catalog-timeout' });
  expect(foreign.result.evidence).toMatchObject({ faultObserved: null, toolCount: null });
  expect(foreign.result.grade.reasons).toEqual(expect.arrayContaining(['USAGE_EVIDENCE_MISSING', 'TOOL_USAGE_EVIDENCE_MISSING']));
});
