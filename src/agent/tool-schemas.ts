import { z } from 'zod';
import type { Change, Snapshot } from '../domain/types.ts';

const id = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !value.includes('\0'));
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const slot = z.enum(['morning', 'afternoon', 'evening']);
export const destinationIdSchema = z.enum(['xiaoliuqiu', 'green-island', 'kenting']);

// Keep a concrete JSON-schema-compatible shape for ADK tool declarations.
// Domain validation remains authoritative for semantic and cross-field rules.
const requirements = z.strictObject({
  destinationId: destinationIdSchema.nullable(),
  days: z.number().int().min(2).max(7), people: z.number().int().min(1).max(6),
  divers: z.number().int().min(0).max(6), startDate: z.iso.date().nullable(),
  budgetMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  lodgingPreference: z.string().max(500), pace: z.enum(['relaxed', 'balanced']),
});

// ADK's Zod 4 OpenAPI exporter feeds Gemini `parameters`, which supports
// anyOf/minimum but not oneOf/exclusiveMinimum. Unique literal kinds keep
// these strict union branches mutually exclusive; integer min(1) stays positive.
const otherChanges = [
  z.strictObject({ kind: z.literal('add'), entry: z.strictObject({
    id, catalogId: id, day: positive, slot, endDay: positive.nullable(), rooms: positive.nullable(),
  }) }),
  z.strictObject({ kind: z.literal('remove'), entryId: id }),
  z.strictObject({ kind: z.literal('move'), entryId: id, day: positive, slot }),
  z.strictObject({ kind: z.literal('replace'), entryId: id, catalogId: id }),
  z.strictObject({ kind: z.literal('rooms'), entryId: id, rooms: positive }),
] as const;
const requirementsPatch = requirements.partial().refine(
  value => Object.keys(value).length > 0 && Object.values(value).every(field => field !== undefined),
  'Submit at least one changed field; omit unchanged fields, never supply undefined.',
).describe('Only changed requirements fields. Omitted fields retain server values. At least one field is required; null explicitly clears a nullable field.');
export const agentChangesSchema = z.array(z.union([
  z.strictObject({ kind: z.literal('requirements'), value: requirementsPatch }), ...otherChanges,
])).min(1).max(100);
// Worker IPC and persisted proposals carry complete replacements, never patches.
export const canonicalAgentChangesSchema = z.array(z.union([
  z.strictObject({ kind: z.literal('requirements'), value: requirements }), ...otherChanges,
])).min(1).max(100);

/** Expand against the trusted run base, in order; domain validation still owns semantics. */
export function expandAgentChanges(snapshot: Snapshot, input: unknown): Change[] {
  let current = { ...snapshot.requirements };
  const expanded = agentChangesSchema.parse(input).map(change => {
    if (change.kind !== 'requirements') return change;
    current = { ...current, ...change.value };
    return { kind: change.kind, value: { ...current } };
  });
  return canonicalAgentChangesSchema.parse(expanded);
}

// Validation input; also retained solely for already-persisted legacy confirmations.
// No actor, snapshot, item payload, or lock/unlock operation is model-controlled.
export const proposalParametersSchema = z.strictObject({ changes: agentChangesSchema });
export const validatedProposalParametersSchema = z.strictObject({
  validationId: z.uuid().describe('Copy the validationId from the latest successful validate_changes result. Do not resubmit changes.'),
});
export type AgentChange = z.infer<typeof agentChangesSchema>[number];

const empty = z.strictObject({});
export const agentToolParameters = {
  find_destinations: empty,
  find_items: z.strictObject({ destinationId: destinationIdSchema }),
  calculate_budget: empty,
  validate_changes: proposalParametersSchema,
  propose_changes: validatedProposalParametersSchema,
} as const;
