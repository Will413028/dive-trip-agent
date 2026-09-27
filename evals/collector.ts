import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { z } from 'zod';
import { parseSnapshot, parseSnapshotStructure } from '../src/domain/snapshot.ts';
import type { TripView } from '../src/domain/types.ts';
import { evaluationInput } from './fixtures.ts';
import { gradeEvidenceV2, type RunEvidence, type RunEvidenceV2 } from './evidence.ts';
import { answerEventSchema, parseAcceptedAnswers, parseReplayBundle, validateAnswerPhase,
  type ProductDecisionReceipt, type ReplayBundle } from './replay-bundle.ts';

export type RecordedEvaluationV2 = {
  schemaVersion: 2; evidence: RunEvidenceV2; events: BaseEvent[]; grade: ReturnType<typeof gradeEvidenceV2>;
};

/** Bounded whole-stream collection. Never treats EOF/HTTP200 as run completion. */
export async function collectEvents(response: Response, signal: AbortSignal): Promise<BaseEvent[]> {
  if (!response.ok) throw new Error(response.status === 429 ? 'EVAL_RATE_LIMIT' : 'EVAL_HTTP_FAILED');
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('EVAL_NOT_SSE');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) throw new Error('EVAL_STREAM_TOO_LARGE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const normalized = text.replaceAll('\r\n', '\n');
    if (!normalized.endsWith('\n\n')) throw new Error('EVAL_TRUNCATED_STREAM');
    const events = normalized.split('\n\n').flatMap(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      return data ? [answerEventSchema.parse(JSON.parse(data))] : [];
    });
    const last = events.at(-1);
    if (!last || ![EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(last.type as EventType.RUN_FINISHED | EventType.RUN_ERROR)) throw new Error('EVAL_INCOMPLETE_STREAM');
    return events;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

const runSchema = z.object({ id: z.uuid(), tripId: z.uuid(), baseVersion: z.number().int().positive(), answerContractVersion: z.literal(1),
  requestId: z.string(), status: z.enum(['running', 'awaiting_confirmation', 'succeeded', 'failed', 'interrupted']),
  events: z.array(z.strictObject({ sequence: z.number().int().nonnegative(), event: answerEventSchema })),
  proposalId: z.uuid().nullable(), interruptId: z.string().nullable(), decision: z.boolean().nullable(),
  proposal: z.object({ draft: z.object({ canApply: z.boolean(), next: z.unknown().transform(parseSnapshotStructure),
    changes: z.array(z.unknown()) }) }).optional() });
const runsSchema = z.object({ runs: z.array(runSchema) });
export type UsageAudit = { model: string; runId: string; complete: boolean; modelCalls: number; costMicros: number | null;
  /** Complete bound native history across start/resume, INCLUDING set_model_response.
   * Missing/incomplete audit stays null, never replaced by visible event counts. */
  nativeToolCalls?: number | null;
  /** Fixed metadata from the product SSOT, never inferred from an answer or current trip version. */
  decisionReceipt?: ProductDecisionReceipt | null;
  /** Trusted private audit only; absence is unknown, never inferred from model/tool prose. */
  faultObserved?: 'catalog-timeout' | null };
export type CollectorPorts = {
  request(path: string, body: unknown | undefined, signal: AbortSignal): Promise<Response>;
  // Setup may create a new isolated fixture; never mutate an existing user's trip.
  setup(input: ReturnType<typeof evaluationInput>, signal: AbortSignal): Promise<TripView>;
  audit(runId: string, signal: AbortSignal): Promise<UsageAudit>;
  model: string;
  faultSupported?: boolean;
  /** Optional synchronous, bounded in-memory capture. Persist the detached bundle
   * in the caller after collection; never load credentials or dispatch from here.
   * Adds only one initial GET /runs. Throws on incomplete/invalid capture. */
  captureReplay?: (bundle: ReplayBundle) => void;
};

async function readTrip(ports: CollectorPorts, id: string, signal: AbortSignal): Promise<TripView> {
  const response = await ports.request(`/api/trips/${id}`, undefined, signal);
  if (!response.ok) throw new Error('EVAL_READ_FAILED');
  const view = await response.json() as TripView;
  if (view.id !== id || !Number.isSafeInteger(view.version) || view.version < 1) throw new Error('EVAL_INVALID_TRIP');
  return { ...view, snapshot: parseSnapshot(view.snapshot) };
}

/** Real route protocol with explicit synthetic-human acceptance only for proposal cases.
 * Returns v2 evidence with pending independent task review, never release readiness. */
export async function collectCase(caseId: string, ports: CollectorPorts): Promise<RecordedEvaluationV2> {
  const input = evaluationInput(caseId);
  if (input.fault && !ports.faultSupported) throw new Error('EVAL_FAULT_ADAPTER_REQUIRED');
  const signal = AbortSignal.timeout(60_000);
  const before = await ports.setup(input, signal);
  if (!isDeepStrictEqual(before.snapshot, input.before)) throw new Error('EVAL_SETUP_MISMATCH');
  let initialRuns: unknown;
  if (ports.captureReplay) {
    const response = await ports.request(`/api/trips/${before.id}/runs`, undefined, signal);
    if (!response.ok) throw new Error('EVAL_READ_FAILED');
    initialRuns = await response.json();
  }
  const started = performance.now();
  const requestId = randomUUID();
  const baseBody = { threadId: before.id, state: {}, tools: [], context: [] };
  const events = await collectEvents(await ports.request(`/api/trips/${before.id}/agent`, {
    ...baseBody, runId: requestId, messages: [{ id: randomUUID(), role: 'user', content: input.prompt }],
    forwardedProps: { baseVersion: before.version },
  }, signal), signal);
  const startEvents = structuredClone(events);
  let resumeEvents: BaseEvent[] = [];
  let publicRuns: unknown;
  const readRun = async () => {
    const response = await ports.request(`/api/trips/${before.id}/runs`, undefined, signal);
    if (!response.ok) throw new Error('EVAL_READ_FAILED');
    const body: unknown = await response.json();
    if (ports.captureReplay) publicRuns = structuredClone(body);
    const matching = runsSchema.parse(body).runs.filter(run => run.requestId === requestId);
    const run = matching[0];
    if (!run || matching.length !== 1) throw new Error('EVAL_RUN_NOT_FOUND');
    if (run.tripId !== before.id || run.baseVersion !== before.version
      || run.events.some((event, index) => index > 0 && event.sequence <= run.events[index - 1].sequence)
      || !isDeepStrictEqual(run.events.map(item => item.event), events)) throw new Error('EVAL_DURABLE_EVENT_MISMATCH');
    return run;
  };
  let run = await readRun();
  const startRun = run;
  const logicalRunId = run.id;
  const afterStartRuns = publicRuns;
  const beforeDecision = await readTrip(ports, before.id, signal);
  if (beforeDecision.version !== before.version || !isDeepStrictEqual(beforeDecision.snapshot, before.snapshot)) throw new Error('EVAL_PRE_APPROVAL_MUTATION');
  validateAnswerPhase(startEvents, { phase: 'start', requestId, before, after: beforeDecision, run });
  let accepted = false;
  let resumeRequestId: string | undefined;
  if (input.terminal === 'proposal' && run.status === 'awaiting_confirmation' && run.proposalId && run.interruptId && run.proposal?.draft.canApply) {
    accepted = true;
    resumeRequestId = randomUUID();
    resumeEvents = await collectEvents(await ports.request(`/api/trips/${before.id}/agent`, {
      ...baseBody, runId: resumeRequestId, messages: [], forwardedProps: { runId: run.id },
      resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed: true } }],
    }, signal), signal);
    events.push(...resumeEvents);
    run = await readRun();
    if (run.id !== logicalRunId) throw new Error('EVAL_ANSWER_RUN_MISMATCH');
  }
  const answers = parseAcceptedAnswers(events, logicalRunId);
  const after = await readTrip(ports, before.id, signal);
  const usage = await ports.audit(run.id, signal);
  if (resumeRequestId !== undefined) {
    if (usage.runId !== run.id || usage.decisionReceipt === undefined) throw new Error('EVAL_PRODUCT_RECEIPT_REQUIRED');
    validateAnswerPhase(resumeEvents, { phase: 'resume', requestId: resumeRequestId,
      before, after, run, previous: { run: startRun, events: startEvents }, decision: true, receipt: usage.decisionReceipt });
  }
  const evidence: RunEvidenceV2 = { caseId, inputDigest: input.digest, runId: run.id,
    before: before.snapshot, beforeDecision: beforeDecision.snapshot, after: after.snapshot,
    beforeVersion: before.version, beforeDecisionVersion: beforeDecision.version, afterVersion: after.version,
    // This provisional classification MUST be confirmed during pending text review.
    terminal: input.terminal as RunEvidence['terminal'], runStatus: run.status === 'interrupted' ? 'abandoned' : run.status,
    decision: accepted ? 'accept' : 'none', proposalId: run.proposalId,
    decisionRunId: accepted && run.decision === true ? run.id : null,
    decisionProposalId: accepted && run.decision === true ? run.proposalId : null,
    model: usage.model, usageRunId: usage.runId, usageComplete: usage.complete,
    modelCalls: usage.modelCalls, toolCount: usage.runId === run.id ? usage.nativeToolCalls ?? null : null,
    visibleToolCount: events.filter(event => event.type === EventType.TOOL_CALL_START).length,
    costMicros: usage.costMicros, latencyMs: performance.now() - started, textReview: 'pending',
    faultObserved: usage.runId === run.id ? usage.faultObserved ?? null : null };
  const grade = gradeEvidenceV2(evidence, ports.model);
  if (answers.some(answer => answer.body.kind === 'failure')) {
    grade.pass = false; grade.reasons.push('ANSWER_INCOMPLETE');
  }
  const result = { schemaVersion: 2 as const, evidence, events, grade };
  if (ports.captureReplay) ports.captureReplay(parseReplayBundle({
    schemaVersion: 2, caseId, inputDigest: input.digest, model: ports.model,
    decisionReceipt: resumeRequestId === undefined ? null : usage.decisionReceipt,
    prompt: input.prompt, catalog: input.catalog, startEvents, resumeEvents,
    initial: { trip: before, runs: initialRuns },
    afterStart: { trip: beforeDecision, runs: afterStartRuns },
    final: { trip: after, runs: publicRuns },
  }));
  return result;
}
