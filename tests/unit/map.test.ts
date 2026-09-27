import { expect, test } from 'vitest';
import data from '../../data/catalog.json';
import { loadCatalog } from '../../src/catalog/catalog';
import { tripMarkers, mapTiles } from '../../src/catalog/map';
import { makeSnapshot } from '../../src/catalog/demo-fixtures';

test('map ignores DEMO and forged coordinates and uses trusted catalog labels', () => {
  const snapshot = makeSnapshot();
  expect(tripMarkers(snapshot)).toEqual([]);
  const item = loadCatalog(data).find(item => item.id === 'vase-rock')!;
  snapshot.entries[1].catalogId = item.id;
  snapshot.entries[1].item = item;
  expect(tripMarkers(snapshot)).toMatchObject([{ id: 'tour', lat: 22.35566, lng: 120.38076 }]);
  snapshot.entries[1].item.title = 'untrusted text';
  expect(tripMarkers(snapshot)[0].label).toContain('花瓶岩');
  snapshot.entries[1].item.lat = 0;
  expect(tripMarkers(snapshot)).toEqual([]);
  snapshot.entries[1].item.lat = 22.35566;
  snapshot.requirements.destinationId = 'kenting';
  expect(tripMarkers(snapshot)).toEqual([]);
});

test('map tiles cover only the fixed viewport and project the equator at the center', () => {
  const tiles = mapTiles(0, 0, 14);
  expect(tiles).toHaveLength(4);
  expect(tiles.map(tile => tile.left)).toEqual([0, 50, 0, 50]);
  expect(tiles[0].top).toBe(-30);
  expect(tiles.every(tile => /^https:\/\/tile.openstreetmap.org\/14\/\d+\/\d+\.png$/.test(tile.url))).toBe(true);
  expect(mapTiles(22.35566, 120.38076, 14).length).toBeLessThanOrEqual(9);
});

test.each([[NaN, 120, 14], [90, 120, 14], [22, 181, 14], [22, 120, 1], [22, 120, 14.5]])('invalid map view rejected: %s %s %s', (lat, lng, zoom) => {
  expect(() => mapTiles(lat, lng, zoom)).toThrow('INVALID_MAP_VIEW');
});
