import { z } from 'zod';
import { formatTwd } from './money.ts';

const id = z.string().min(1).max(128);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(1).max(2147483647);
const uniqueIds = z.array(id).max(20).refine(ids => new Set(ids).size === ids.length);
export const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/);
export const clarificationFieldSchema = z.enum(['destination', 'dates', 'people', 'divers', 'budget', 'lodging', 'rooms', 'pace', 'target-item']);
const fields = z.array(clarificationFieldSchema).min(1).max(9).refine(values => new Set(values).size === values.length);
export const unsupportedReasonSchema = z.enum(['outside-scope', 'booking', 'payment', 'safety-guarantee']);
// Literal kinds still discriminate the TS union. Zod union exports anyOf;
// discriminatedUnion exports oneOf, unsupported by ADK's Gemini Schema path.
// The wire version is a string because Gemini enum values are strings.
export const answerPlanSchema = z.strictObject({ version: z.literal('1'), answer: z.union([
  z.strictObject({ kind: z.literal('clarify'), fields }),
  z.strictObject({ kind: z.literal('requirements'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('destinations'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('items'), evidenceRef: evidenceIdSchema, itemIds: uniqueIds }),
  z.strictObject({ kind: z.literal('budget'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('compare-budget'), currentRef: evidenceIdSchema, candidateRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('conflict'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('proposal'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('receipt'), evidenceRef: evidenceIdSchema }),
  z.strictObject({ kind: z.literal('unsupported'), reason: unsupportedReasonSchema }),
]) });
export type AnswerPlan = z.infer<typeof answerPlanSchema>;

export const evidenceBindingSchema = z.strictObject({ ownerId: z.uuid(), tripId: z.uuid(), runId: z.uuid(), baseVersion: version });
export type EvidenceBinding = z.infer<typeof evidenceBindingSchema>;

// These values are public projections, never model inputs accepted as evidence.
const moneySchema = z.strictObject({ minor: integer, display: z.string().max(64) })
  .refine(value => value.display === formatTwd(value.minor));
export const sourceSchema = z.strictObject({ id, url: z.url({ protocol: /^https$/ }).nullable(),
  checkedAt: z.iso.date(), kind: z.enum(['fact', 'demo']), label: z.string().min(1).max(4000) });
const issueCode = z.enum(['INVALID_CHANGE', 'INVALID_ACTOR', 'LOCKED_ENTRY', 'INVALID_CATALOG', 'DUPLICATE_ENTRY',
  'CATALOG_NOT_FOUND', 'ENTRY_NOT_FOUND', 'DESTINATION_MISMATCH', 'DATE_OUT_OF_RANGE', 'INVALID_LODGING',
  'CAPACITY', 'OVERLAP', 'BUDGET_INVALID', 'BUDGET_EXCEEDED', 'UNKNOWN_COST', 'EXCLUDED_COST']);
const issueSchema = z.strictObject({ code: issueCode, entryId: id.optional() });
export const budgetPresentationSchema = z.strictObject({
  scope: z.enum(['current', 'candidate']), baseVersion: version,
  known: moneySchema, target: moneySchema.nullable(), withinBudget: z.boolean().nullable(), containsDemo: z.boolean(),
  unknownCosts: z.array(z.strictObject({ entryId: id, title: z.string().max(4000), reason: z.string().min(1).max(4000),
    source: sourceSchema, provenanceSources: z.array(sourceSchema).max(128) })).max(128),
  exclusions: z.array(z.string().max(4000)).max(128), issues: z.array(issueSchema).max(256),
  sources: z.array(z.strictObject({ entryId: id, source: sourceSchema, provenanceSources: z.array(sourceSchema).max(128) })).max(128),
  locked: z.strictObject({ status: z.enum(['unavailable', 'budget-unspecified', 'locked-known-cost-exceeds-budget', 'not-proven-infeasible']),
    known: moneySchema.nullable(), entryIds: z.array(id).max(128), unknownEntryIds: z.array(id).max(128).nullable() }),
}).refine(value => value.withinBudget === null || (value.target !== null && value.unknownCosts.length === 0 && value.exclusions.length === 0))
  .refine(value => value.withinBudget === null || value.withinBudget === (value.known.minor <= value.target!.minor));
export type BudgetPresentation = z.infer<typeof budgetPresentationSchema>;
const destinationId = z.enum(['xiaoliuqiu', 'green-island', 'kenting']);
export const itemPresentationSchema = z.strictObject({ id, title: z.string().max(4000),
  audience: z.enum(['all', 'divers', 'non-divers']), capacityPerRoom: integer.nullable(),
  price: moneySchema.nullable(), unit: z.enum(['person', 'room-night', 'group']), unknownReason: z.string().max(4000).nullable(),
  containsDemo: z.boolean(), source: sourceSchema, provenanceSources: z.array(sourceSchema).max(128),
}).refine(item => (item.price === null) === (item.unknownReason !== null));
export const requirementsPresentationSchema = z.strictObject({ destinationId: destinationId.nullable(),
  days: z.number().int().min(2).max(7), people: z.number().int().min(1).max(6), divers: z.number().int().min(0).max(6),
  startDate: z.iso.date().nullable(), target: moneySchema.nullable(), lodgingPreference: z.string().max(4000),
  pace: z.enum(['relaxed', 'balanced']),
}).refine(value => value.divers <= value.people);
const bodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clarify'), fields }),
  z.strictObject({ kind: z.literal('requirements'), version, requirements: requirementsPresentationSchema }),
  z.strictObject({ kind: z.literal('destinations'), destinations: z.array(z.strictObject({ id: destinationId,
    itemCount: integer, demoItemCount: integer })).max(3) }),
  z.strictObject({ kind: z.literal('items'), destinationId, items: z.array(itemPresentationSchema).max(20),
    total: integer, omittedCount: integer }).refine(value => value.items.length + value.omittedCount === value.total),
  z.strictObject({ kind: z.literal('budget'), budget: budgetPresentationSchema }),
  z.strictObject({ kind: z.literal('compare-budget'), current: budgetPresentationSchema, candidate: budgetPresentationSchema })
    .refine(value => value.current.scope === 'current' && value.candidate.scope === 'candidate'
      && value.current.baseVersion === value.candidate.baseVersion),
  z.strictObject({ kind: z.literal('conflict'), budget: budgetPresentationSchema }),
  z.strictObject({ kind: z.literal('proposal'), proposalRef: evidenceIdSchema, changeCount: integer, budget: budgetPresentationSchema }),
  z.strictObject({ kind: z.literal('receipt'), status: z.enum(['applied', 'rejected']), version }),
  z.strictObject({ kind: z.literal('unsupported'), reason: unsupportedReasonSchema }),
  z.strictObject({ kind: z.literal('failure'), reason: z.enum(['invalid-answer', 'incomplete-run', 'unsupported-version']),
    committed: z.strictObject({ status: z.enum(['applied', 'rejected']), version }).nullable() }),
]);
export const ANSWER_MAX_BYTES = 32_000;
export const acceptedAnswerSchema = z.strictObject({ schemaVersion: z.literal(1), templateVersion: z.literal(1),
  answerId: z.string().regex(/^ans_[a-f0-9]{64}$/), runId: z.uuid(),
  evidenceRefs: z.array(evidenceIdSchema).max(4), body: bodySchema })
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= ANSWER_MAX_BYTES);
export type AcceptedAnswer = z.infer<typeof acceptedAnswerSchema>;
export const ANSWER_EVENT_NAME = 'dive_trip.answer.v1';
