import type { Event } from '@google/adk';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadCatalog } from '../catalog/catalog.ts';
import { buildProposal } from '../domain/proposal.ts';
import { parseSnapshotStructure } from '../domain/snapshot.ts';
import type { CatalogItem, ProposalDraft, Snapshot } from '../domain/types.ts';
import { agentToolParameters, expandAgentChanges } from './tool-schemas.ts';

export const READ_TOOL_NAMES = ['find_destinations', 'find_items', 'calculate_budget', 'validate_changes'] as const;
export type ReadToolName = typeof READ_TOOL_NAMES[number];
export type ReadToolRecord = { id: string; name: ReadToolName; args: unknown; result: unknown };
export type ReadToolHistory = { records: ReadToolRecord[]; latestValidationCallId: string | undefined };
export function isReadToolName(name: unknown): name is ReadToolName {
  return READ_TOOL_NAMES.some(read => read === name);
}
const invalidHistory = (): never => { throw new Error('AGENT_TOOL_HISTORY'); };

/** Pair only durable, server-owned read tools, in response order. Error results
 * remain records; unfinished calls have none. The latest validation is selected
 * by call order, even when it fails, never returns, or completes out of order.
 * Consumers validate result contents and their own evidence references. */
export function readToolHistory(events: readonly Event[]): ReadToolHistory {
  const calls = new Map<string, Omit<ReadToolRecord, 'result'>>();
  const callIds = new Set<string>();
  const resolved = new Set<string>();
  const records: ReadToolRecord[] = [];
  let latestValidationCallId: string | undefined;
  for (const event of events) {
    if (event.partial || event.author === 'user') continue;
    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (call && isReadToolName(call.name)) {
        if (typeof call.id !== 'string' || !call.id || callIds.has(call.id)) return invalidHistory();
        calls.set(call.id, { id: call.id, name: call.name, args: call.args });
        if (call.name === 'validate_changes') latestValidationCallId = call.id;
      } else if (call?.id && calls.has(call.id)) {
        return invalidHistory();
      }
      if (call?.id) callIds.add(call.id);
      const response = part.functionResponse;
      if (!response) continue;
      const original = response.id ? calls.get(response.id) : undefined;
      if (!original && !isReadToolName(response.name)) continue;
      if (!response.id || !original || original.name !== response.name || resolved.has(response.id)) return invalidHistory();
      resolved.add(response.id);
      records.push({ ...original, result: response.response });
    }
  }
  return { records, latestValidationCallId };
}

/** Reconstruct the domain verdict from the bound inputs, without requiring an
 * answerEvidenceRef (native confirmation probes also use this contract). */
export function resolveValidationResult(snapshot: Snapshot, catalog: CatalogItem[], args: unknown, result: unknown): {
  base: Snapshot; draft: ProposalDraft; validationId: string | null;
} {
  const response = z.record(z.string(), z.unknown()).parse(result);
  if ('error' in response) throw new Error('AGENT_EVIDENCE_INVALID');
  const base = parseSnapshotStructure(snapshot), items = loadCatalog(catalog);
  const { changes } = agentToolParameters.validate_changes.parse(args);
  const draft = buildProposal(base, expandAgentChanges(base, changes), items, 'agent');
  const validationId = z.uuid().nullable().parse(response.validationId);
  if (response.canApply !== draft.canApply || (validationId !== null) !== draft.canApply
    || !isDeepStrictEqual(response.budget, draft.budget) || !isDeepStrictEqual(response.issues, draft.issues)) {
    throw new Error('AGENT_EVIDENCE_INVALID');
  }
  return { base, draft, validationId };
}
