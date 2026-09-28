import { isDeepStrictEqual } from 'node:util';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { loadCatalog } from '../src/catalog/catalog.ts';
import { parseSnapshot, parseSnapshotStructure } from '../src/domain/snapshot.ts';
import { parseRequirements } from '../src/domain/schemas.ts';
import { calculateBudget } from '../src/domain/budget.ts';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME, type AcceptedAnswer } from '../src/domain/answer.ts';
import type { TripView } from '../src/domain/types.ts';
import { reviewProposal } from '../src/server/proposal-review.ts';

// v1 is isolated historical data. Only v2 can enter the core replay transport.
const id = z.string().min(1).max(128);
const positive = z.number().int().positive().max(2147483647);
const slot = z.enum(['morning', 'afternoon', 'evening']);
const budget = z.strictObject({ knownMinor: z.number().int().nonnegative(),
  unknownEntryIds: z.array(id), withinBudget: z.boolean().nullable() });
const trip = z.strictObject({ id: z.uuid(), version: positive,
  snapshot: z.unknown().transform(parseSnapshot), budget });
const change = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requirements'), value: z.unknown().transform(parseRequirements) }),
  z.strictObject({ kind: z.literal('add'), entry: z.strictObject({ id, catalogId: id,
    day: positive, slot, endDay: positive.nullable(), rooms: positive.nullable() }) }),
  z.strictObject({ kind: z.literal('remove'), entryId: id }),
  z.strictObject({ kind: z.literal('move'), entryId: id, day: positive, slot }),
  z.strictObject({ kind: z.literal('replace'), entryId: id, catalogId: id }),
  z.strictObject({ kind: z.literal('rooms'), entryId: id, rooms: positive }),
  z.strictObject({ kind: z.literal('lock'), entryId: id, locked: z.boolean() }),
]);
const draft = z.strictObject({ next: z.unknown().transform(parseSnapshotStructure), budget,
  issues: z.array(z.strictObject({ code: id, message: z.string(), entryId: id.optional() })),
  changes: z.array(change), canApply: z.boolean() });
const publicEventTypes = new Set<string>([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR,
  EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]);
const historicalEvent = z.unknown().transform(value => {
  const parsed = EventSchemas.parse(value);
  // No silent stripping of extra fields. In particular, never export rawEvent.
  if (!isDeepStrictEqual(parsed, value) || 'rawEvent' in parsed || !publicEventTypes.has(parsed.type)) throw new Error('REPLAY_EVENT_FIELDS');
  return parsed;
});
const currentEventTypes = new Set<string>([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR,
  EventType.TOOL_CALL_START, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT, EventType.CUSTOM]);
/** No raw model/tool text, unknown custom payloads, or silently stripped fields. */
export const answerEventSchema = z.unknown().transform((value, context) => {
  const result = EventSchemas.safeParse(value);
  const reject = (message: string) => { context.addIssue({ code: 'custom', message }); return z.NEVER; };
  if (!result.success) return reject('EVAL_ANSWER_EVENT_SCHEMA');
  const parsed = result.data;
  if (!isDeepStrictEqual(parsed, value) || 'rawEvent' in parsed || !currentEventTypes.has(parsed.type)
    || (parsed.type === EventType.RUN_FINISHED && parsed.result !== undefined)
    || (parsed.type === EventType.TOOL_CALL_RESULT && parsed.content !== '{}')) return reject('EVAL_ANSWER_EVENT_FIELDS');
  if (parsed.type === EventType.CUSTOM) {
    if (parsed.name !== ANSWER_EVENT_NAME) return reject('EVAL_ANSWER_EVENT_VERSION');
    if (!acceptedAnswerSchema.safeParse(parsed.value).success) return reject('EVAL_ACCEPTED_ANSWER_SCHEMA');
  }
  return parsed;
});

/** Checks public reference structure, not private Evidence provenance or task success.
 * Repeated identical IDs are idempotent; an ID may never acquire a new projection. */
export function parseAcceptedAnswers(events: readonly unknown[], runId: string): AcceptedAnswer[] {
  z.uuid().parse(runId);
  const answers = new Map<string, AcceptedAnswer>();
  for (const value of events) {
    const event = answerEventSchema.parse(value);
    if (event.type !== EventType.CUSTOM) continue;
    const answer = acceptedAnswerSchema.parse(event.value);
    if (answer.runId !== runId) throw new Error('EVAL_ANSWER_RUN_MISMATCH');
    const { body, evidenceRefs: refs } = answer;
    const count = body.kind === 'clarify' || body.kind === 'unsupported' ? 0
      : body.kind === 'compare-budget' ? 2 : body.kind === 'failure' ? Number(body.committed !== null) : 1;
    if (refs.length !== count || new Set(refs).size !== refs.length
      || (body.kind === 'proposal' && refs[0] !== body.proposalRef)) throw new Error('EVAL_ANSWER_REFS_MISMATCH');
    const previous = answers.get(answer.answerId);
    if (previous && !isDeepStrictEqual(previous, answer)) throw new Error('EVAL_ANSWER_ID_CONFLICT');
    answers.set(answer.answerId, answer);
  }
  return [...answers.values()];
}

export function validateAnswerStream(events: readonly unknown[], binding: { tripId: string; requestId: string; runId: string }) {
  const parsed = events.map(event => answerEventSchema.parse(event));
  const first = parsed[0], last = parsed.at(-1);
  if (first?.type !== EventType.RUN_STARTED || first.runId !== binding.requestId || first.threadId !== binding.tripId
    || !last || (last.type !== EventType.RUN_FINISHED && last.type !== EventType.RUN_ERROR)
    || (last.type === EventType.RUN_FINISHED && (last.runId !== binding.requestId || last.threadId !== binding.tripId))
    || parsed.slice(1).some(event => event.type === EventType.RUN_STARTED)
    || parsed.slice(0, -1).some(event => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR)) {
    throw new Error('EVAL_ANSWER_STREAM_MISMATCH');
  }
  const answers = parseAcceptedAnswers(parsed, binding.runId);
  if (last.type === EventType.RUN_FINISHED && !answers.length) throw new Error('EVAL_ACCEPTED_ANSWER_REQUIRED');
  return answers;
}

export const productDecisionReceiptSchema = z.strictObject({ runId: z.uuid(),
  status: z.enum(['applied', 'rejected']), version: positive });
export type ProductDecisionReceipt = z.infer<typeof productDecisionReceiptSchema>;
type PhaseRun = { id: string; tripId: string; baseVersion: number;
  status: 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'interrupted';
  proposalId: string | null; interruptId: string | null; decision: boolean | null;
  proposal?: { draft: { canApply: boolean; next: TripView['snapshot']; changes: readonly unknown[] } } };
type PhaseBinding = { requestId: string; before: TripView; after: TripView; run: PhaseRun } & (
  { phase: 'start' } | { phase: 'resume'; previous: { run: PhaseRun; events: readonly unknown[] };
    decision: boolean; receipt: ProductDecisionReceipt | null }
);

/** Completion is phase-specific, not just a run-bound CUSTOM before EOF.
 * Check against product checkpoints/decision, never the model's receipt alone.
 * This is consistency validation of trusted collector data, not authentication
 * of arbitrary JSON or a claim of task/quality success. */
export function validateAnswerPhase(events: readonly unknown[], binding: PhaseBinding): AcceptedAnswer[] {
  const { before, after, run } = binding;
  const fail = (): never => { throw new Error('EVAL_ANSWER_PHASE_MISMATCH'); };
  if (run.tripId !== before.id || after.id !== before.id || run.baseVersion !== before.version
    || run.status === 'running') fail();
  const answers = validateAnswerStream(events, { tripId: before.id, runId: run.id, requestId: binding.requestId });
  const terminal = answerEventSchema.parse(events.at(-1));
  const finished = run.status === 'succeeded' || run.status === 'awaiting_confirmation';
  if ((finished && terminal.type !== EventType.RUN_FINISHED)
    || (!finished && terminal.type !== EventType.RUN_ERROR)) fail();
  const unchanged = after.version === before.version && isDeepStrictEqual(after.snapshot, before.snapshot);
  let committed: { status: 'applied' | 'rejected'; version: number } | null = null;
  let fresh = answers;
  if (binding.phase === 'start') {
    if (run.decision !== null || !unchanged) fail();
  } else {
    const previous = binding.previous;
    if (previous.run.id !== run.id || previous.run.tripId !== run.tripId
      || previous.run.baseVersion !== run.baseVersion || previous.run.status !== 'awaiting_confirmation'
      || previous.run.decision !== null || !previous.run.proposalId || !previous.run.interruptId
      || run.proposalId !== previous.run.proposalId || run.interruptId !== previous.run.interruptId
      || run.decision !== binding.decision || run.status === 'awaiting_confirmation') fail();
    const prior = parseAcceptedAnswers(previous.events, run.id);
    // Compare all IDs before removing idempotent deliveries from this phase.
    parseAcceptedAnswers([...previous.events, ...events], run.id);
    if (previous.events.some(event => {
      const parsed = answerEventSchema.parse(event);
      return parsed.type === EventType.RUN_STARTED && parsed.runId === binding.requestId;
    })) fail();
    fresh = answers.filter(answer => !prior.some(old => old.answerId === answer.answerId));
    const receipt = binding.receipt === null ? null : productDecisionReceiptSchema.parse(binding.receipt);
    if (receipt) {
      if (receipt.runId !== run.id || receipt.status !== (binding.decision ? 'applied' : 'rejected')
        || receipt.version !== after.version) fail();
      if (binding.decision ? after.version !== before.version + 1 || !previous.run.proposal?.draft.canApply
        || !isDeepStrictEqual(after.snapshot, previous.run.proposal.draft.next) : !unchanged) fail();
      committed = { status: receipt.status, version: receipt.version };
    } else if (!unchanged || finished) fail(); // A failed claim may precede the actual product commit.
  }
  for (const answer of fresh) {
    const body = answer.body;
    if (body.kind === 'receipt' && (!committed || !isDeepStrictEqual(committed, { status: body.status, version: body.version }))) fail();
    if (body.kind === 'failure' && !isDeepStrictEqual(committed, body.committed)) fail();
    if (committed && body.kind !== 'receipt' && body.kind !== 'failure') fail();
    if (body.kind === 'proposal' && (binding.phase !== 'start' || !run.proposalId || !run.interruptId
      || !run.proposal?.draft.canApply || body.changeCount !== run.proposal.draft.changes.length
      || body.budget.scope !== 'candidate' || body.budget.baseVersion !== before.version)) fail();
  }
  if (finished) {
    // One new immutable projection completes a phase. Previous answers may be
    // redelivered, but cannot substitute for the receipt of a later invocation.
    if (fresh.length !== 1) throw new Error('EVAL_PHASE_ANSWER_REQUIRED');
    const body = fresh[0].body;
    if (run.status === 'awaiting_confirmation') {
      if (body.kind !== 'proposal') fail();
      if (terminal.type === EventType.RUN_FINISHED && terminal.outcome !== undefined
        && (terminal.outcome.type !== 'interrupt' || terminal.outcome.interrupts.length !== 1
          || terminal.outcome.interrupts[0].id !== run.interruptId)) fail();
    } else {
      if (body.kind === 'failure' || body.kind === 'proposal'
        || (binding.phase === 'resume' && body.kind !== 'receipt')
        || (binding.phase === 'start' && (run.proposalId !== null || run.interruptId !== null || body.kind === 'receipt'))
        || (terminal.type === EventType.RUN_FINISHED && terminal.outcome !== undefined && terminal.outcome.type !== 'success')) fail();
    }
  }
  return answers;
}

const run = z.strictObject({ id: z.uuid(), tripId: z.uuid(), requestId: id, baseVersion: positive,
  message: z.string().min(1).max(4000),
  status: z.enum(['running', 'awaiting_confirmation', 'succeeded', 'failed', 'interrupted']),
  events: z.array(z.strictObject({ sequence: z.number().int().nonnegative(), event: historicalEvent })),
  proposalId: z.uuid().nullable(), interruptId: id.nullable(), decision: z.boolean().nullable(),
  proposal: z.strictObject({ draft, base: trip }).optional() });
const checkpoint = z.strictObject({ trip, runs: z.strictObject({ runs: z.array(run).max(1) }) });
const historicalSchema = z.strictObject({ schemaVersion: z.literal(1), caseId: id,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), model: id, prompt: z.string().min(1).max(4000),
  catalog: z.unknown().transform(loadCatalog), initial: checkpoint, afterStart: checkpoint, final: checkpoint,
  startEvents: z.array(historicalEvent).min(1), resumeEvents: z.array(historicalEvent) });
const proposalReview = z.strictObject({
  differences: z.array(z.strictObject({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })),
  knownDeltaMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
});
const currentProposal = z.strictObject({ draft, base: trip, review: proposalReview.optional() }).superRefine((value, context) => {
  if (value.review && !isDeepStrictEqual(value.review,
    JSON.parse(JSON.stringify(reviewProposal(value.base.snapshot, value.draft))))) {
    context.addIssue({ code: 'custom', message: 'REPLAY_PROPOSAL_REVIEW_MISMATCH' });
  }
});
const currentRun = run.extend({ answerContractVersion: z.literal(1), executor: z.enum(['adk', 'temporal-v1']).optional(), proposal: currentProposal.optional(), events: z.array(z.strictObject({
  sequence: z.number().int().nonnegative(), event: answerEventSchema })) });
const currentCheckpoint = checkpoint.extend({ runs: z.strictObject({ runs: z.array(currentRun).max(1) }) });
const schema = historicalSchema.extend({ schemaVersion: z.literal(2),
  decisionReceipt: productDecisionReceiptSchema.nullable(),
  initial: currentCheckpoint, afterStart: currentCheckpoint, final: currentCheckpoint,
  startEvents: z.array(answerEventSchema).min(1), resumeEvents: z.array(answerEventSchema) });
export type ReplayBundle = z.infer<typeof schema>;
export type HistoricalReplayBundle = z.infer<typeof historicalSchema>;
export const REPLAY_MAX_BYTES = 4 * 1024 * 1024;

/** Pure validation; no DB, model, file, environment or network access.
 * Provenance (report hash + bundle hash + live transport audit) belongs to caller.
 * A valid bundle by itself is not proof that its source was a live model. */
export function parseReplayBundle(value: unknown): ReplayBundle {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > REPLAY_MAX_BYTES) throw new Error('REPLAY_TOO_LARGE');
  const b = validateReplayCheckpoints(schema.parse(value));
  const run = b.afterStart.runs.runs[0];
  validateAnswerPhase(b.startEvents, { phase: 'start', requestId: run.requestId,
    before: b.initial.trip, after: b.afterStart.trip, run });
  if (b.resumeEvents.length) {
    const first = b.resumeEvents[0];
    if (first.type !== EventType.RUN_STARTED) throw new Error('REPLAY_INCONSISTENT');
    validateAnswerPhase(b.resumeEvents, { phase: 'resume', requestId: first.runId,
      before: b.initial.trip, after: b.final.trip, run: b.final.runs.runs[0],
      previous: { run, events: b.startEvents }, decision: true, receipt: b.decisionReceipt });
  } else if (b.decisionReceipt !== null) throw new Error('EVAL_ANSWER_PHASE_MISMATCH');
  parseAcceptedAnswers([...b.startEvents, ...b.resumeEvents], run.id);
  return b;
}

/** Detached read-only historical inspection; deliberately no v1 playback API,
 * migration, regrading, or conversion to AcceptedAnswer. */
export function parseHistoricalReplayBundle(value: unknown): HistoricalReplayBundle {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > REPLAY_MAX_BYTES) throw new Error('REPLAY_TOO_LARGE');
  return validateReplayCheckpoints(historicalSchema.parse(value));
}

function validateReplayCheckpoints<T extends ReplayBundle | HistoricalReplayBundle>(b: T): T {
  const fail = () => { throw new Error('REPLAY_INCONSISTENT'); };
  const a = b.afterStart.runs.runs[0], f = b.final.runs.runs[0];
  if (b.initial.runs.runs.length || !a || !f || a.id !== f.id || a.requestId !== f.requestId ||
    a.message !== b.prompt || f.message !== b.prompt || !isDeepStrictEqual(b.initial.trip, b.afterStart.trip)) fail();
  for (const c of [b.initial, b.afterStart, b.final]) {
    if (c.trip.id !== b.initial.trip.id || !isDeepStrictEqual(c.trip.budget, calculateBudget(c.trip.snapshot))) fail();
    for (const r of c.runs.runs) {
      if (r.tripId !== c.trip.id || r.baseVersion !== b.initial.trip.version ||
        r.events.some((e, i) => i > 0 && e.sequence <= r.events[i - 1].sequence)) fail();
      if (r.proposal && (!r.proposalId || !isDeepStrictEqual(r.proposal.base, b.initial.trip))) fail();
    }
  }
  const checkStream = (events: ReplayBundle['startEvents']) => {
    if (events[0]?.type !== EventType.RUN_STARTED ||
      ![EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(events.at(-1)!.type as EventType.RUN_FINISHED | EventType.RUN_ERROR)) fail();
    for (const e of events) if ('threadId' in e && e.threadId !== b.initial.trip.id) fail();
    if (events.slice(1).some(e => e.type === EventType.RUN_STARTED) ||
      events.slice(0, -1).some(e => e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR)) fail();
    const first = events[0], last = events.at(-1)!;
    if ('runId' in first && 'runId' in last && first.runId !== last.runId) fail();
  };
  checkStream(b.startEvents);
  if (!('runId' in b.startEvents[0]) || b.startEvents[0].runId !== a.requestId) fail();
  // Durable stream is authoritative: do not manufacture answers, tools or endings.
  if (!isDeepStrictEqual(a.events.map(e => e.event), b.startEvents) ||
    !isDeepStrictEqual(f.events.map(e => e.event), [...b.startEvents, ...b.resumeEvents])) fail();
  if (b.resumeEvents.length) {
    checkStream(b.resumeEvents);
    if (a.status !== 'awaiting_confirmation' || !a.interruptId || !a.proposalId || !a.proposal?.draft.canApply ||
      a.decision !== null || f.decision !== true || f.proposalId !== a.proposalId) fail();
    // Preserve the exact v1 historical contract. V2 completion/failed-before-
    // commit checkpoints are validated by the shared phase helper above.
    if (b.schemaVersion === 1 && (b.final.trip.version !== b.initial.trip.version + 1 ||
      !isDeepStrictEqual(b.final.trip.snapshot, a.proposal!.draft.next))) fail();
  } else if (!isDeepStrictEqual(b.afterStart, b.final)) fail();
  return structuredClone(b);
}

export type ReplayReply = { status: number; json?: unknown; sse?: string };
/** Finite UI transport. Unknown/out-of-order requests throw, never fall through.
 * Request UUIDs are browser-generated correlation values, so only RUN_STARTED /
 * RUN_FINISHED transport runId and its public requestId are rebound in responses
 * so ChatPanel can reconcile its pending attempt. Original bundle stays intact;
 * logical run/proposal/interrupt IDs and AcceptedAnswer values are unchanged. */
export function createEvidenceReplay(value: unknown) {
  const bundle = parseReplayBundle(value);
  let phase: 'initial' | 'afterStart' | 'final' = 'initial';
  let posts = 0;
  const requestIds = new Map<string, string>();
  const rebindEvent = (event: ReplayBundle['startEvents'][number]) =>
    event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED
      ? { ...event, runId: requestIds.get(event.runId) ?? event.runId } : event;
  const base = `/api/trips/${bundle.initial.trip.id}`;
  return {
    get phase() { return phase; }, get posts() { return posts; },
    respond(method: string, path: string, body?: unknown): ReplayReply {
      if (method === 'GET') {
        if (path === base) return { status: 200, json: structuredClone(bundle[phase].trip) };
        if (path === `${base}/runs`) {
          const projection = structuredClone(bundle[phase].runs);
          for (const run of projection.runs) {
            if (run.proposal && !run.proposal.review) {
              run.proposal.review = reviewProposal(run.proposal.base.snapshot, run.proposal.draft);
            }
            run.requestId = requestIds.get(run.requestId) ?? run.requestId;
            run.events = run.events.map(item => ({ ...item, event: rebindEvent(item.event) }));
          }
          return { status: 200, json: projection };
        }
        if (path === '/api/catalog') return { status: 200, json: structuredClone(bundle.catalog) };
        // Presentation shim, hidden by recording overlay; never claims live mode.
        if (path === '/api/agent-mode') return { status: 200, json: { mode: 'fixture' } };
        // Out-of-scope UI is hidden; do not fabricate a saved shares projection.
        if (path === `${base}/shares`) return { status: 409, json: { error: 'REPLAY_UNAVAILABLE' } };
      }
      if (method !== 'POST' || path !== `${base}/agent`) throw new Error('REPLAY_UNEXPECTED_REQUEST');
      const request = z.strictObject({ threadId: z.literal(bundle.initial.trip.id), runId: id,
        protocolVersion: z.literal(PROTOCOL_VERSION).optional(),
        messages: z.array(z.object({ role: z.literal('user'), content: z.string() })),
        forwardedProps: z.unknown(), resume: z.unknown().optional(),
        tools: z.array(z.unknown()).length(0), context: z.array(z.unknown()).length(0), state: z.strictObject({}),
      }).parse(body);
      let events: ReplayBundle['startEvents'];
      if (phase === 'initial') {
        if (request.resume !== undefined || request.messages.length !== 1 || request.messages[0].content !== bundle.prompt ||
          !isDeepStrictEqual(request.forwardedProps, { baseVersion: bundle.initial.trip.version })) throw new Error('REPLAY_START_MISMATCH');
        events = bundle.startEvents; phase = 'afterStart';
      } else if (phase === 'afterStart' && bundle.resumeEvents.length) {
        const run = bundle.afterStart.runs.runs[0];
        if (request.messages.length || !isDeepStrictEqual(request.forwardedProps, { runId: run.id }) ||
          !isDeepStrictEqual(request.resume, [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed: true } }])) throw new Error('REPLAY_RESUME_MISMATCH');
        events = bundle.resumeEvents; phase = 'final';
      } else throw new Error('REPLAY_UNEXPECTED_DISPATCH');
      const first = events[0];
      if (first.type !== EventType.RUN_STARTED) throw new Error('REPLAY_START_REQUIRED');
      requestIds.set(first.runId, request.runId);
      posts++;
      return { status: 200, sse: events.map(event => `data: ${JSON.stringify(rebindEvent(event))}\n\n`).join('') };
    },
  };
}
