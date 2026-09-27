import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { evidenceBindingSchema, type EvidenceBinding } from '../domain/answer.ts';
import { calculateBudget } from '../domain/budget.ts';
import { parseSnapshotStructure } from '../domain/snapshot.ts';
import { loadCatalog } from '../catalog/catalog.ts';
import type { CatalogItem, DestinationId, ProposalDraft, Snapshot } from '../domain/types.ts';
import { agentToolParameters } from './tool-schemas.ts';
import { resolveValidationResult } from './tool-history.ts';

type Header = { id: string; binding: EvidenceBinding; originId: string };
export type AnswerEvidence = Header & (
  | { kind: 'requirements'; scope: 'current'; snapshot: Snapshot }
  | { kind: 'destinations'; scope: 'catalog'; catalog: CatalogItem[] }
  | { kind: 'items'; scope: 'catalog'; destinationId: DestinationId; items: CatalogItem[]; total: number }
  | { kind: 'budget'; scope: 'current'; snapshot: Snapshot }
  | { kind: 'validation'; scope: 'candidate'; base: Snapshot; draft: ProposalDraft; validationId: string | null }
  | { kind: 'proposal'; scope: 'candidate'; base: Snapshot; draft: ProposalDraft; validationRef: string }
  | { kind: 'receipt'; scope: 'committed'; status: 'applied' | 'rejected'; version: number }
);
export type ValidationEvidence = Extract<AnswerEvidence, { kind: 'validation' }>;
export type ReceiptEvidence = Extract<AnswerEvidence, { kind: 'receipt' }>;
const originSchema = z.string().min(1).max(128);
const record = z.record(z.string(), z.unknown());
const invalid = (): never => { throw new Error('AGENT_EVIDENCE_INVALID'); };
export function evidenceIdentity(binding: EvidenceBinding, kind: AnswerEvidence['kind'], originId: string): string {
  const parsed = evidenceBindingSchema.parse(binding);
  return `ev_${createHash('sha256').update(JSON.stringify([parsed.ownerId, parsed.tripId, parsed.runId,
    parsed.baseVersion, kind, originSchema.parse(originId)])).digest('hex')}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function seal<T extends AnswerEvidence>(value: T): T { return freeze(structuredClone(value)); }
function header(binding: EvidenceBinding, kind: AnswerEvidence['kind'], originId: string): Header {
  return { id: evidenceIdentity(binding, kind, originId), binding: evidenceBindingSchema.parse(binding), originId };
}
export function requirementsEvidence(binding: EvidenceBinding, snapshot: Snapshot): AnswerEvidence {
  return seal({ ...header(binding, 'requirements', 'bound-snapshot'), kind: 'requirements', scope: 'current',
    snapshot: parseSnapshotStructure(snapshot) });
}

/** Only call with server-executed tool records from the bound, ordered session.
 * Never deserialize an Evidence object from model/user JSON. Reconstruct from
 * original bound inputs and domain rules; tool prose is never a fact template.
 */
export function toolEvidence(binding: EvidenceBinding, snapshot: Snapshot, catalog: CatalogItem[],
  tool: { id: string; name: string; args: unknown; result: unknown }): AnswerEvidence {
  if (tool.name === 'validate_changes') {
    const validation = resolveValidationResult(snapshot, catalog, tool.args, tool.result);
    return seal({ ...header(binding, 'validation', tool.id), kind: 'validation', scope: 'candidate', ...validation });
  }
  const result = record.parse(tool.result);
  if ('error' in result) return invalid();
  const base = parseSnapshotStructure(snapshot), items = loadCatalog(catalog);
  switch (tool.name) {
    case 'find_destinations': {
      agentToolParameters.find_destinations.parse(tool.args);
      if (!Array.isArray(result.destinations)) return invalid();
      return seal({ ...header(binding, 'destinations', tool.id), kind: 'destinations', scope: 'catalog', catalog: items });
    }
    case 'find_items': {
      const { destinationId } = agentToolParameters.find_items.parse(tool.args);
      const matches = items.filter(item => item.destinationId === destinationId);
      const ids = z.array(z.object({ id: originSchema })).max(20).parse(result.items).map(item => item.id);
      if (new Set(ids).size !== ids.length || result.total !== matches.length || result.omittedCount !== matches.length - ids.length) return invalid();
      const selected = ids.map(id => matches.find(item => item.id === id) ?? invalid());
      return seal({ ...header(binding, 'items', tool.id), kind: 'items', scope: 'catalog', destinationId, items: selected, total: matches.length });
    }
    case 'calculate_budget': {
      agentToolParameters.calculate_budget.parse(tool.args);
      const budget = calculateBudget(base);
      if (!isDeepStrictEqual({ knownMinor: result.knownMinor, unknownEntryIds: result.unknownEntryIds, withinBudget: result.withinBudget }, budget)) return invalid();
      return seal({ ...header(binding, 'budget', tool.id), kind: 'budget', scope: 'current', snapshot: base });
    }
    default: return invalid();
  }
}

/** Created only after resolving a real native confirmation gate. */
export function proposalEvidence(validation: ValidationEvidence, nativeToolCallId: string): AnswerEvidence {
  if (!validation.draft.canApply || !validation.validationId) return invalid();
  return seal({ ...header(validation.binding, 'proposal', nativeToolCallId), kind: 'proposal', scope: 'candidate',
    base: validation.base, draft: validation.draft, validationRef: validation.id });
}

/** The authenticated transaction/receipt store, NOT model text, supplies result.
 * A rejected decision can observe a newer version without claiming it changed it.
 */
export function receiptEvidence(binding: EvidenceBinding, nativeToolCallId: string,
  result: { status: 'applied' | 'rejected'; version: number }): ReceiptEvidence {
  const value = z.strictObject({ status: z.enum(['applied', 'rejected']), version: z.number().int().min(1).max(2147483647) }).parse(result);
  if (value.version < binding.baseVersion || (value.status === 'applied' && value.version !== binding.baseVersion + 1)) return invalid();
  return seal({ ...header(binding, 'receipt', nativeToolCallId), kind: 'receipt', scope: 'committed', ...value });
}
