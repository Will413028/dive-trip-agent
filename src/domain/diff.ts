import type { Entry, Snapshot } from './types.ts';

// Presentation paths use /entries/<escaped stable ID>, not array offsets.
// These are not executable JSON Patch operations. /entries reports an actual
// relative reorder of retained entries as their ordered IDs.
export function diffSnapshots(before: Snapshot, after: Snapshot): { path: string; before: unknown; after: unknown }[] {
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
  const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  function visit(left: unknown, right: unknown, path: string): void {
    if (Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (path === '/entries') {
        const oldEntries = new Map((left as Entry[]).map(entry => [entry.id, entry]));
        const newEntries = new Map((right as Entry[]).map(entry => [entry.id, entry]));
        for (const id of new Set([...oldEntries.keys(), ...newEntries.keys()])) {
          visit(oldEntries.get(id), newEntries.get(id), `${path}/${escape(id)}`);
        }
        const oldOrder = [...oldEntries.keys()].filter(id => newEntries.has(id));
        const newOrder = [...newEntries.keys()].filter(id => oldEntries.has(id));
        if (oldOrder.some((id, index) => id !== newOrder[index])) {
          changes.push({ path, before: oldOrder, after: newOrder });
        }
      } else {
        for (let i = 0; i < Math.max(left.length, right.length); i++) visit(left[i], right[i], `${path}/${i}`);
      }
    } else if (object(left) && object(right) && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        visit(left[key], right[key], `${path}/${escape(key)}`);
      }
    } else {
      changes.push({ path, before: structuredClone(left), after: structuredClone(right) });
    }
  }
  visit(before, after, '');
  return changes;
}
