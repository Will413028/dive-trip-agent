import type { CatalogItem, Snapshot } from '../domain/types.ts';

function disclosure(items: CatalogItem[]) {
  const containsDemo = items.some(item => item.price.basis === 'demo'
    || item.sources.some(source => source.kind === 'demo'));
  return { containsDemo };
}
export function priceDisclosure(snapshot: Snapshot) {
  return disclosure(snapshot.entries.map(entry => entry.item));
}
