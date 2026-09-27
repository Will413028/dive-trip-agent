import { z } from 'zod';
import { loadCatalog } from '../catalog/catalog.ts';
import { buildProposal } from './proposal.ts';
import { parseRequirements } from './schemas.ts';
import type { Snapshot } from './types.ts';

const text = z.string().refine(value => value.trim().length > 0);
const positive = z.number().int().positive();
const schema = z.strictObject({
  requirements: z.unknown().transform(value => parseRequirements(value)),
  entries: z.array(z.strictObject({
    id: text, catalogId: text, day: positive,
    slot: z.enum(['morning', 'afternoon', 'evening']),
    endDay: positive.nullable(), rooms: positive.nullable(), locked: z.boolean(),
    item: z.unknown().transform(value => loadCatalog([value])[0]),
  })),
  exclusions: z.array(text),
});

// Server-created snapshots only. HTTP accepts changes, never a client snapshot.
// Revalidate persisted JSON before using it; do not trust a TypeScript cast.
export function parseSnapshotStructure(input: unknown): Snapshot {
  const snapshot = schema.parse(input);
  if (snapshot.entries.some(entry => entry.catalogId !== entry.item.id)) throw new Error('SNAPSHOT_ITEM_MISMATCH');
  return snapshot;
}

export function parseSnapshot(input: unknown): Snapshot {
  const snapshot = parseSnapshotStructure(input);
  const catalog = [...new Map(snapshot.entries.map(entry => [entry.item.id, entry.item])).values()];
  const draft = buildProposal(snapshot, [], catalog, 'user');
  if (!draft.canApply) throw new Error('INVALID_SNAPSHOT');
  return snapshot;
}
