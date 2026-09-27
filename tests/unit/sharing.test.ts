import { expect, test } from 'vitest';
import { hashPreview, previewShare } from '../../src/server/share-store';
import { makeSnapshot } from '../support/domain-fixtures';
import { calculateBudget } from '../../src/domain/budget';
import { catalog } from '../../src/server/demo';

test('public projection omits free text, dates, internal IDs and untrusted catalog prose', () => {
  const snapshot = makeSnapshot();
  snapshot.requirements.lodgingPreference = 'PRIVATE_PHONE_0912345678';
  snapshot.requirements.startDate = '2027-12-31';
  snapshot.exclusions = ['PRIVATE_PHONE_0912345678'];
  snapshot.entries[0].id = 'PRIVATE_ENTRY_ID';
  snapshot.entries[0].item.title = 'DEMO PRIVATE_PHONE_0912345678';
  snapshot.entries[0].item.sources[0].label = 'DEMO PRIVATE_PHONE_0912345678';
  const result = previewShare({ id: 'PRIVATE_TRIP_ID', version: 99, snapshot, budget: calculateBudget(snapshot) });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|2027-12-31|lodgingPreference|startDate|locked|catalogId|sourceId/);
  expect(result.entries[0]).toMatchObject({ sourceVerified: false, demo: true, sources: [] });
  expect(result.budget).toEqual({ knownMinor: 430000, limitMinor: 1000000, unknownCount: 0, exclusionsCount: 1 });
});
test('approved catalog retains public sources and demo label, not IDs', () => {
  const snapshot = makeSnapshot();
  snapshot.entries.forEach(entry => { entry.item = catalog().find(item => item.id === entry.catalogId)!; });
  const result = previewShare({ id: 'private', version: 1, snapshot, budget: calculateBudget(snapshot) });
  expect(result.entries.every(entry => entry.sourceVerified && entry.demo && entry.sources.length > 0)).toBe(true);
  expect(result.entries[0]).not.toHaveProperty('id');
  expect(result.entries[0].sources[0]).not.toHaveProperty('id');
});
test('preview hash is canonical for object order but preserves array order', () => {
  const snapshot = makeSnapshot();
  const result = previewShare({ id: 'private', version: 1, snapshot, budget: calculateBudget(snapshot) });
  const reordered = { entries: result.entries, budget: result.budget, people: result.people, days: result.days, destinationId: result.destinationId };
  expect(hashPreview(result)).toBe(hashPreview(reordered));
  expect(hashPreview(result)).not.toBe(hashPreview({ ...result, entries: [...result.entries].reverse() }));
});
