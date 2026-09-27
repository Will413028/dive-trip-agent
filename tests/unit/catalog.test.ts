import { expect, test } from 'vitest';
import data from '../../data/catalog.json';
import { findItems, loadCatalog } from '../../src/catalog/catalog';
import { makeSnapshot } from '../support/domain-fixtures';
import type { CatalogItem } from '../../src/domain/types';

const items = () => makeSnapshot().entries.map(entry => entry.item);

test.each([
  ['vase-rock', 'xiaoliuqiu', 22.35566, 120.38076],
  ['green-island-lighthouse', 'green-island', 22.67664, 121.466101],
  ['eluanbi-lighthouse', 'kenting', 21.902017, 120.852485],
])('%s 保存查核座標但不冒充已知價格或可訂商品', (id, destination, lat, lng) => {
  const item = loadCatalog(data).find(item => item.id === id)!;
  expect(item).toMatchObject({ destinationId: destination, lat, lng, kind: 'activity',
    price: { unitMinor: null, basis: 'estimate' } });
  expect(item.title).toContain('開放與費用待確認');
  expect(item.price.unknownReason).toContain('非報價');
  expect(item.sources).toHaveLength(1);
  expect(item.sources[0]).toMatchObject({ kind: 'fact', checkedAt: '2026-09-22' });
  expect(new URL(item.sources[0].url!).hostname).toMatch(/\.gov\.tw$|^tcmb\.culture\.tw$/);
});

// Catches empty/dropped catalogs, coercion, and mutation of caller-owned data.
test('載入保留資料並隔離輸入物件', () => {
  const input = items();
  const result = loadCatalog(input);
  expect(result).toEqual(input);
  result[0].sources[0].label = 'changed';
  expect(input[0].sources[0].label).toBe('DEMO 示範資料，非真實報價');
});

test.each(['xiaoliuqiu', 'green-island', 'kenting'] as const)('%s 具明示 DEMO 住宿、陸上及潛水活動', destination => {
  const catalog = loadCatalog(data);
  const found = findItems(catalog, destination).filter(item => item.price.basis === 'demo');
  expect(found.length).toBeGreaterThanOrEqual(3);
  expect(found.every(item => item.destinationId === destination)).toBe(true);
  expect(found.some(item => item.kind === 'lodging')).toBe(true);
  expect(found.some(item => item.kind === 'activity' && item.audience === 'all')).toBe(true);
  expect(found.some(item => item.kind === 'activity' && item.audience === 'divers')).toBe(true);
  for (const item of found) {
    expect(item.title).toMatch(/DEMO/);
    expect(item.price.basis).toBe('demo');
    expect([item.lat, item.lng]).toEqual([null, null]);
    for (const source of item.sources) {
      expect(source.kind).toBe('demo');
      expect(source.url).toBeNull();
      expect(source.label).toMatch(/DEMO/);
    }
  }
});

test('findItems 保留匹配順序且不更動原目錄', () => {
  const catalog = items();
  catalog[1].destinationId = 'kenting';
  const before = structuredClone(catalog);
  expect(findItems(catalog, 'xiaoliuqiu').map(item => item.id)).toEqual(['stay', 'transfer']);
  expect(findItems(catalog, 'green-island')).toEqual([]);
  expect(catalog).toEqual(before);
});

test('拒絕重複 ID', () => {
  const input = items();
  expect(() => loadCatalog([...input, input[0]])).toThrow();
});

const invalid: [string, (item: CatalogItem) => void][] = [
  ['空 ID', item => { item.id = ' '; }],
  ['錯 destination', item => { Object.assign(item, { destinationId: 'okinawa' }); }],
  ['缺來源', item => { item.sources = []; }],
  ['錯 price sourceId', item => { item.price.sourceId = 'missing'; }],
  ['重複 source ID', item => { item.sources.push({ ...item.sources[0] }); }],
  ['fact 缺 URL', item => { item.sources[0].kind = 'fact'; }],
  ['HTTP URL', item => { item.sources[0].url = 'http://example.com'; }],
  ['非 URL', item => { item.sources[0].url = 'not-a-url'; }],
  ['空來源標籤', item => { item.sources[0].label = ' '; }],
  ['demo 來源未標示', item => { item.sources[0].label = '資料'; }],
  ['demo 標題未標示', item => { item.title = '住宿'; }],
  ['非法查核日', item => { item.sources[0].checkedAt = '2026-02-30'; }],
  ['只有緯度', item => { item.lat = 22; }],
  ['只有經度', item => { item.lng = 120; }],
  ['緯度超界', item => { item.lat = 91; item.lng = 120; }],
  ['經度超界', item => { item.lat = 22; item.lng = 181; }],
  ['null 價無原因', item => { item.price.unitMinor = null; }],
  ['null 價空原因', item => { item.price.unitMinor = null; item.price.unknownReason = ' '; }],
  ['已知價帶原因', item => { item.price.unknownReason = '未查'; }],
  ['負價', item => { item.price.unitMinor = -1; }],
  ['小數價', item => { item.price.unitMinor = 1.5; }],
  ['unsafe 價', item => { item.price.unitMinor = Number.MAX_SAFE_INTEGER + 1; }],
  ['非有限價', item => { item.price.unitMinor = Infinity; }],
  ['字串價', item => { Object.assign(item.price, { unitMinor: '100' }); }],
  ['缺容量', item => { item.capacityPerRoom = null; }],
  ['零容量', item => { item.capacityPerRoom = 0; }],
  ['小數容量', item => { item.capacityPerRoom = 1.5; }],
  ['unsafe 容量', item => { item.capacityPerRoom = Number.MAX_SAFE_INTEGER + 1; }],
  ['住宿錯單位', item => { item.price.unit = 'person'; }],
  ['活動錯單位', item => { item.kind = 'activity'; }],
  ['活動帶容量', item => { item.kind = 'activity'; item.price.unit = 'group'; }],
  ['多餘欄位', item => { Object.assign(item, { hidden: true }); }],
];

test.each(invalid)('拒絕不合法目錄：%s', (_, mutate) => {
  const input = items();
  mutate(input[0]);
  expect(() => loadCatalog(input)).toThrow();
});

test.each([null, {}, 'catalog', [null]])('拒絕非 catalog 輸入 %j', input => {
  expect(() => loadCatalog(input)).toThrow();
});

test('接受 HTTPS fact、成對座標、未知估價與已知零價', () => {
  const input = items();
  Object.assign(input[0], { title: '來源測試', lat: 22, lng: 120 });
  Object.assign(input[0].sources[0], { kind: 'fact', url: 'https://example.com/source', label: '測試來源' });
  Object.assign(input[0].price, { basis: 'estimate', unitMinor: null, unknownReason: '待確認' });
  input[1].price.unitMinor = 0;
  expect(loadCatalog(input)).toEqual(input);
  expect(loadCatalog([])).toEqual([]);
});
