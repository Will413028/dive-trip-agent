import type { Event } from '@google/adk';
import { z } from 'zod';
import type { CatalogItem, Change, Snapshot } from '../domain/types.ts';
import { readToolHistory, resolveValidationResult } from './tool-history.ts';
import { validatedProposalParametersSchema } from './tool-schemas.ts';

export type ConfirmationGate = {
  interruptId: string; toolCallId: string; changes: Change[]; eventId: string;
};

/** Resolve only the latest durable server validation, never model-supplied changes.
 * The caller has already bound this session to the original snapshot/catalog.
 * No in-memory registry or separate persistence is needed across worker restarts.
 */
export function confirmationGates(events: readonly Event[], snapshot: Snapshot, catalog: CatalogItem[]): ConfirmationGate[] {
  return events.flatMap((event, index) => {
    if (event.partial || event.author === 'user') return [];
    return (event.content?.parts ?? []).flatMap((part, partIndex) => {
      const call = part.functionCall;
      if (call?.name !== 'adk_request_confirmation' || !call.id) return [];
      const original = z.object({ id: z.string().min(1), name: z.literal('propose_changes'), args: z.unknown() })
        .parse(call.args?.originalFunctionCall);
      const reference = validatedProposalParametersSchema.safeParse(original.args);
      let changes: Change[];
      if (reference.success) {
        try {
          const prior = [...events.slice(0, index), { ...event,
            content: { ...event.content, parts: event.content!.parts!.slice(0, partIndex) } }];
          const history = readToolHistory(prior);
          const latest = history.records.find(record => record.id === history.latestValidationCallId);
          if (!latest) throw new Error('AGENT_VALIDATION_REFERENCE');
          const validation = resolveValidationResult(snapshot, catalog, latest.args, latest.result);
          if (!validation.draft.canApply || validation.validationId !== reference.data.validationId) {
            throw new Error('AGENT_VALIDATION_REFERENCE');
          }
          changes = validation.draft.changes;
        } catch {
          throw new Error('AGENT_VALIDATION_REFERENCE');
        }
      } else {
        // Pre-contract histories stay readable offline, never executable here.
        throw new Error('AGENT_LEGACY_READ_ONLY');
      }
      return [{ interruptId: call.id, toolCallId: original.id, changes, eventId: event.id }];
    });
  });
}
