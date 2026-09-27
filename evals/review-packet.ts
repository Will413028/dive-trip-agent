import { isDeepStrictEqual } from 'node:util';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import cases from './cases.json' with { type: 'json' };
import { parseSnapshot } from '../src/domain/snapshot.ts';
import { calculateBudget } from '../src/domain/budget.ts';
import { diffSnapshots } from '../src/domain/diff.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../src/agent/cloudflare-wire.ts';
import { answerEventSchema, parseAcceptedAnswers } from './replay-bundle.ts';
import type { AcceptedAnswer } from '../src/domain/answer.ts';

const natural = z.number().int().nonnegative();
const identity = { round: z.number().int().min(1).max(3), caseId: z.string().min(1) };
const grade = z.strictObject({ pass: z.boolean(), reasons: z.array(z.string()), safetyFailures: z.array(z.string()) });
// Project only review fields; collector accounting/approval fields are not regraded here.
const evidence = z.object({
  caseId: z.string(), runId: z.string().min(1), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().optional(),
  terminal: z.enum(['proposal', 'clarification', 'blocked']),
  runStatus: z.enum(['succeeded', 'failed', 'abandoned', 'awaiting_confirmation', 'running']),
  before: z.unknown().transform(parseSnapshot), after: z.unknown().transform(parseSnapshot),
});
const historicalEvent = EventSchemas.refine(event => event.type !== 'CUSTOM' || !event.name.startsWith('dive_trip.answer.'));
const collected = z.strictObject({ ...identity, outcome: z.enum(['completed', 'failed']),
  evidence, events: z.array(historicalEvent), grade });
const failure = z.strictObject({ ...identity, outcome: z.literal('failed'), reason: z.string().min(1), costMicros: z.null() });
const skipped = z.strictObject({ ...identity, outcome: z.literal('skipped'), reason: z.string().min(1) });
const audit = z.strictObject({ ...identity, kind: z.literal('durable-audit'), chargedMicros: natural,
  privateUsage: z.array(usageEvidenceSchema).optional(), privateUsageComplete: z.boolean().optional(),
  quiescent: z.boolean().optional(),
  runs: z.array(z.strictObject({ id: z.string().min(1), status: z.string().min(1),
    proposal_id: z.string().nullable(), interrupt_id: z.string().nullable(), decision: z.boolean().nullable() })),
  events: z.array(z.strictObject({ run_id: z.string().min(1), sequence: natural, event: historicalEvent })),
});
const reportFields = {
  budgetMicros: natural, chargedMicros: natural, stopped: z.string().nullable(),
  textReview: z.enum(['pending', 'passed', 'failed']), evaluationGatePassed: z.boolean(),
  records: z.array(z.union([collected, failure, skipped, audit])),
};
const historicalReportSchema = z.discriminatedUnion('transport', [
  z.object({ ...reportFields, schemaVersion: z.literal(1).optional(), model: z.string().min(1), transport: z.literal('real-gemini-via-http-handler') }),
  z.object({ ...reportFields, schemaVersion: z.literal(1).optional(), model: z.literal(CLOUDFLARE_MODEL), accountId: cloudflareAccountSchema,
    transport: z.literal('real-cloudflare-via-http-handler') }),
]);
const toolUsageSchema = z.object({ toolCount: natural.nullable(), visibleToolCount: natural });
const currentCollected = collected.extend({ schemaVersion: z.literal(2),
  evidence: evidence.extend({ runId: z.uuid(), toolCount: natural.nullable(), visibleToolCount: natural }),
  events: z.array(answerEventSchema) });
const currentAudit = audit.extend({ events: z.array(z.strictObject({ run_id: z.uuid(), sequence: natural, event: answerEventSchema })) });
const currentReportFields = { ...reportFields, schemaVersion: z.literal(2),
  records: z.array(z.union([currentCollected, failure, skipped, currentAudit])) };
const reportSchema = z.discriminatedUnion('transport', [
  z.object({ ...currentReportFields, model: z.string().min(1), transport: z.literal('real-gemini-via-http-handler') }),
  z.object({ ...currentReportFields, model: z.literal(CLOUDFLARE_MODEL), accountId: cloudflareAccountSchema,
    transport: z.literal('real-cloudflare-via-http-handler') }),
]);
type Report = z.infer<typeof historicalReportSchema> | z.infer<typeof reportSchema>;
type RecordRow = Report['records'][number];
type Attempt = Exclude<RecordRow, { kind: 'durable-audit' }>;
const pair = (row: { round: number; caseId: string }) => `${row.round}:${row.caseId}`;

/** Pure projection of trusted collector JSON, not evidence authentication or a grader.
 * The caller bounds bytes BEFORE JSON.parse. No IO, source mutation or human approval.
 * Collector terminal is provisional expected data, never an observed classification.
 */
export function buildReviewPacket(report: unknown) {
  return { ...projectReviewPacket(reportSchema.parse(report), false, (_events, acceptedAnswers) => ({
    acceptedAnswers, answerValidation: { schemaAndRunBinding: acceptedAnswers.length ? 'checked' as const : 'no-answer' as const,
      referenceStructure: acceptedAnswers.length ? 'checked' as const : 'no-answer' as const,
      // A report projection lacks per-phase product checkpoints. Schema/run
      // agreement (even with a supplied passing grade) is not completion proof.
      phaseCompletion: 'not-verified' as const, productReceipt: 'not-verified' as const,
      privateEvidenceProvenance: 'not-verified' as const }, taskReview: 'pending' as const,
  })), schemaVersion: 2 as const,
    mode: 'accepted-answer-review' as const };
}

/** Explicit historical read-only entry. Missing version means the old v1 report,
 * never implicit migration. Source grades/unknowns stay historical evidence. */
export function buildHistoricalReviewPacket(report: unknown) {
  return { ...projectReviewPacket(historicalReportSchema.parse(report), true, events => ({
    modelProse: events.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').map(event => event.delta).join(''),
  })), schemaVersion: 1 as const,
    mode: 'historical-v1-read-only' as const };
}

function projectReviewPacket<Content extends object>(source: Report, historical: boolean,
  content: (events: z.infer<typeof EventSchemas>[], answers: AcceptedAnswer[]) => Content) {
  const attempts = new Map<string, Attempt>();
  const audits = new Map<string, z.infer<typeof audit>>();
  for (const row of source.records) {
    if (!cases.some(spec => spec.id === row.caseId)) throw new Error('UNEXPECTED_CASE_ID');
    const key = pair(row);
    if ('kind' in row) {
      if (audits.has(key)) throw new Error('DUPLICATE_DURABLE_AUDIT');
      audits.set(key, row);
    } else {
      if (attempts.has(key)) throw new Error('DUPLICATE_ROUND_CASE');
      if ('evidence' in row && row.evidence.caseId !== row.caseId) throw new Error('EVIDENCE_CASE_MISMATCH');
      if (source.transport === 'real-cloudflare-via-http-handler' && 'evidence' in row
        && row.evidence.model !== source.model) throw new Error('EVAL_REVIEW_MODEL_MISMATCH');
      attempts.set(key, row);
    }
  }
  for (const [key, durable] of audits) {
    const attempt = attempts.get(key);
    const expectedRun = attempt && 'evidence' in attempt ? attempt.evidence.runId : undefined;
    const runIds = new Set(durable.runs.map(run => run.id));
    if ((!historical || source.transport === 'real-cloudflare-via-http-handler')
      && (runIds.size !== durable.runs.length
        || (!historical && expectedRun && !runIds.has(expectedRun))
        || (expectedRun && durable.runs.some(run => run.id !== expectedRun))
        || durable.events.some(event => !runIds.has(event.run_id) || (expectedRun && event.run_id !== expectedRun)))) {
      throw new Error('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
    }
    if (!historical) {
      for (const runId of runIds) {
        const items = durable.events.filter(item => item.run_id === runId);
        if (items.some((item, index) => index > 0 && item.sequence <= items[index - 1].sequence)) {
          throw new Error('EVAL_REVIEW_EVENT_SEQUENCE');
        }
        parseAcceptedAnswers(items.map(item => item.event), runId);
      }
      if (attempt && 'evidence' in attempt && !isDeepStrictEqual(
        parseAcceptedAnswers(attempt.events, attempt.evidence.runId),
        parseAcceptedAnswers(durable.events.map(item => item.event), attempt.evidence.runId))) {
        throw new Error('EVAL_REVIEW_ANSWER_MISMATCH');
      }
    }
    for (const usage of durable.privateUsage ?? []) {
      if (source.transport === 'real-cloudflare-via-http-handler') {
        if (usage.schemaVersion !== 2 || usage.binding.provider !== 'cloudflare'
          || usage.binding.model !== source.model || usage.binding.accountId !== source.accountId
          || !runIds.has(usage.runId) || (expectedRun && usage.runId !== expectedRun)) {
          throw new Error('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
        }
      } else if (usage.schemaVersion !== 1) throw new Error('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
    }
  }
  const reviews = [1, 2, 3].flatMap(round => cases.map(spec => {
    const key = pair({ round, caseId: spec.id });
    const row = attempts.get(key);
    const e = row && 'evidence' in row ? row.evidence : null;
    const durable = audits.get(key);
    // Durable evidence can recover a failed collection, never another attempt.
    const events = row && 'events' in row ? row.events : durable?.events.map(item => item.event) ?? [];
    const diffs = e ? diffSnapshots(e.before, e.after) : null;
    const changedEntryIds = e ? [...new Set([...e.before.entries, ...e.after.entries].map(entry => entry.id))]
      .filter(id => !isDeepStrictEqual(e.before.entries.find(entry => entry.id === id), e.after.entries.find(entry => entry.id === id))) : null;
    const acceptedAnswers = historical ? [] : e ? parseAcceptedAnswers(events, e.runId)
      : (durable?.runs ?? []).flatMap(run => parseAcceptedAnswers(
        durable!.events.filter(item => item.run_id === run.id).map(item => item.event), run.id));
    if (!historical && e?.runStatus === 'succeeded' && !acceptedAnswers.length) throw new Error('EVAL_ACCEPTED_ANSWER_REQUIRED');
    const toolUsage = !historical && e ? toolUsageSchema.parse(e) : null;
    return {
      round, caseId: spec.id, outcome: row?.outcome ?? 'missing',
      reason: row && 'reason' in row ? row.reason : row ? null : 'MISSING_ATTEMPT',
      runId: e?.runId ?? null, inputDigest: e?.inputDigest ?? null,
      expectedTerminal: { value: e?.terminal ?? spec.terminal,
        source: e ? 'source-report-provisional-terminal' : 'current-case-manifest', observed: false as const },
      observedTerminal: null, runStatus: e?.runStatus ?? null,
      ...content(events, acceptedAnswers),
      ...(!historical ? { toolUsage: toolUsage
        ? { nativeToolCount: toolUsage.toolCount, visibleToolCount: toolUsage.visibleToolCount } : null } : {}),
      eventSource: row && 'events' in row ? 'attempt' : durable ? 'durable-audit' : 'missing',
      actualToolCallNames: events.filter(event => event.type === 'TOOL_CALL_START').map(event => event.toolCallName),
      requirementDiffs: diffs?.filter(diff => diff.path.startsWith('/requirements/')) ?? null,
      changedEntryIds,
      entryOrderChanged: diffs ? diffs.some(diff => diff.path === '/entries') : null,
      exclusions: e ? { before: e.before.exclusions, after: e.after.exclusions } : null,
      budget: e ? { before: calculateBudget(e.before), after: calculateBudget(e.after) } : null,
      originalGrade: row && 'grade' in row ? row.grade : null,
      durableAuditPresent: !!durable,
      privateUsageEvidence: durable?.privateUsage ?? null,
      privateUsageExportComplete: durable?.privateUsageComplete ?? false,
      quiescent: durable?.quiescent ?? null,
      textReview: 'pending' as const,
    };
  }));
  const count = (outcome: string) => reviews.filter(row => row.outcome === outcome).length;
  return {
    model: source.model, transport: source.transport, stopped: source.stopped,
    ...(source.transport === 'real-cloudflare-via-http-handler' ? { accountId: source.accountId } : {}),
    textReview: 'pending' as const, evaluationGatePassed: false as const,
    ...(historical ? {} : { taskReview: 'pending' as const }),
    coverage: { expectedCases: 30, recordedCases: attempts.size,
      attemptedCases: count('completed') + count('failed'), completedCases: count('completed'),
      failedCases: count('failed'), skippedCases: count('skipped'), missingCases: count('missing'),
      durableAuditRecords: audits.size, complete: attempts.size === 30,
      allCasesAttempted: count('completed') + count('failed') === 30 },
    cases: reviews,
  };
}
