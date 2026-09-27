import { expect, test } from 'vitest';
import { diffSnapshots } from '../../src/domain/diff';
import { makeSnapshot } from '../support/domain-fixtures';
import type { Snapshot } from '../../src/domain/types';

test('相同項目與不同 object key 順序無 diff', () => {
  const s = makeSnapshot();
  const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)])) : value;
  expect(diffSnapshots(s, reordered(s) as Snapshot)).toEqual([]);
});
test('日期、房數、來源與 exclusions 以穩定 ID 展示路徑描述', () => {
  const s = makeSnapshot(); const after = structuredClone(s);
  after.requirements.startDate = '2026-10-01'; after.entries[0].rooms = 2;
  after.entries[0].item.sources[0].label = 'DEMO 新資料'; after.exclusions.push('餐費');
  expect(diffSnapshots(s, after)).toEqual([
    { path: '/entries/stay/item/sources/0/label', before: 'DEMO 示範資料，非真實報價', after: 'DEMO 新資料' },
    { path: '/entries/stay/rooms', before: 1, after: 2 },
    { path: '/exclusions/0', before: undefined, after: '餐費' },
    { path: '/requirements/startDate', before: null, after: '2026-10-01' },
  ]);
});
test('新增／刪除保留完整 entry，回傳值不 alias snapshot', () => {
  const s = makeSnapshot(); const after = structuredClone(s); const removed = after.entries.pop()!;
  const diff = diffSnapshots(s, after);
  expect(diff).toEqual([{ path: '/entries/transfer', before: removed, after: undefined }]);
  expect(diffSnapshots(after, s)).toEqual([{ path: '/entries/transfer', before: undefined, after: removed }]);
  (diff[0].before as typeof removed).item.price.unitMinor = 0;
  expect(s.entries[2].item.price.unitMinor).toBe(30000);
});

test('刪除／插入中間活動不誤報其他活動變更', () => {
  const before = makeSnapshot();
  const after = structuredClone(before);
  const [removed] = after.entries.splice(1, 1);
  expect(diffSnapshots(before, after)).toEqual([
    { path: '/entries/tour', before: removed, after: undefined },
  ]);
  expect(diffSnapshots(after, before)).toEqual([
    { path: '/entries/tour', before: undefined, after: removed },
  ]);
});

test('移除與修改按 ID 配對，特殊 ID 正確 escape', () => {
  const before = makeSnapshot();
  before.entries[2].id = 'trip/~transfer';
  const after = structuredClone(before);
  after.entries.splice(1, 1);
  after.entries[1].day = 3;
  expect(diffSnapshots(before, after)).toEqual([
    { path: '/entries/tour', before: before.entries[1], after: undefined },
    { path: '/entries/trip~1~0transfer/day', before: 2, after: 3 },
  ]);
});
test('array 順序為行程快照語義一部分', () => {
  const s = makeSnapshot(); const after = structuredClone(s); after.entries.reverse();
  expect(diffSnapshots(s, after)).toEqual([
    { path: '/entries', before: ['stay', 'tour', 'transfer'], after: ['transfer', 'tour', 'stay'] },
  ]);
  expect(s.entries[0].id).toBe('stay');
});
