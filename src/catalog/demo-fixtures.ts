import type { CatalogItem, Snapshot } from '../domain/types';

export function makeSnapshot(): Snapshot {
  const item = (id: string, unit: CatalogItem['price']['unit'], unitMinor: number): CatalogItem => ({
    id, destinationId: 'xiaoliuqiu', kind: unit === 'room-night' ? 'lodging' : 'activity',
    title: `DEMO 示範 ${id}`, audience: 'all', capacityPerRoom: unit === 'room-night' ? 2 : null,
    lat: null, lng: null,
    price: { unit, unitMinor, basis: 'demo', sourceId: 'demo', unknownReason: null },
    sources: [{ id: 'demo', url: null, checkedAt: '2026-09-19', kind: 'demo', label: 'DEMO 示範資料，非真實報價' }],
  });
  return {
    requirements: {
      destinationId: 'xiaoliuqiu', days: 4, people: 2, divers: 1,
      startDate: null, budgetMinor: 1000000, lodgingPreference: '示範雙人房', pace: 'balanced',
    },
    entries: [
      { id: 'stay', catalogId: 'stay', day: 1, slot: 'evening', endDay: 4, rooms: 1, locked: false, item: item('stay', 'room-night', 100000) },
      { id: 'tour', catalogId: 'tour', day: 2, slot: 'morning', endDay: null, rooms: null, locked: false, item: item('tour', 'person', 50000) },
      { id: 'transfer', catalogId: 'transfer', day: 2, slot: 'afternoon', endDay: null, rooms: null, locked: false, item: item('transfer', 'group', 30000) },
    ],
    exclusions: [],
  };
}
