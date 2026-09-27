import { expect, test } from 'vitest';
import { buildProposal } from '../../src/domain/proposal';
import { makeSnapshot } from '../support/domain-fixtures';
import type { CatalogItem, Change, Snapshot } from '../../src/domain/types';

const catalogOf = (s: Snapshot) => structuredClone(s.entries.map(e => e.item));
const propose = (s: Snapshot, changes: Change[], actor: 'agent' | 'user' = 'agent', catalog = catalogOf(s)) =>
  buildProposal(s, changes, catalog, actor);
function blocked(s: Snapshot, changes: Change[], code: string, actor: 'agent' | 'user' = 'agent', catalog = catalogOf(s)) {
  const original = structuredClone(s);
  const result = propose(s, changes, actor, catalog);
  expect(result.canApply).toBe(false);
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  expect(s).toEqual(original);
  return result;
}

// Each case catches a bypass of immutable lock protection or actor authorization.
test('Agent 不能透過刪除或解鎖修改已鎖住宿', () => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  blocked(s, [{ kind: 'lock', entryId: 'stay', locked: false }, { kind: 'remove', entryId: 'stay' }], 'LOCKED_ENTRY');
  expect(s.entries).toHaveLength(3);
});
test.each(['agent', 'user'] as const)('%s 不可直接更動已鎖內容／房數', actor => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  blocked(s, [{ kind: 'rooms', entryId: 'stay', rooms: 2 }], 'LOCKED_ENTRY', actor);
});
test.each(['agent', 'user'] as const)('%s 不可解鎖混合其他操作', actor => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  blocked(s, [{ kind: 'lock', entryId: 'stay', locked: false }, { kind: 'remove', entryId: 'stay' }], 'LOCKED_ENTRY', actor);
});
test.each([true, false])('user singleton lock=%s', locked => {
  const s = makeSnapshot(); s.entries[0].locked = !locked;
  const result = propose(s, [{ kind: 'lock', entryId: 'stay', locked }], 'user');
  expect(result.canApply).toBe(true);
  expect(result.next.entries[0].locked).toBe(locked);
  expect(s.entries[0].locked).toBe(!locked);
});
test('Agent 也不能自行加鎖', () => {
  blocked(makeSnapshot(), [{ kind: 'lock', entryId: 'stay', locked: true }], 'LOCKED_ENTRY');
});
test('user 加鎖也必須單獨操作', () => {
  blocked(makeSnapshot(), [{ kind: 'lock', entryId: 'stay', locked: true }, { kind: 'remove', entryId: 'tour' }], 'LOCKED_ENTRY', 'user');
});
test('天數縮減不能繞過鎖定退房日', () => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  const result = blocked(s, [{ kind: 'requirements', value: { ...s.requirements, days: 3 } }], 'LOCKED_ENTRY');
  expect(result.next.requirements.days).toBe(3);
});
test.each([['2026-09-19', '2026-09-20'], [null, '2026-09-19'], ['2026-09-19', null]] as const)('鎖定絕對日期 %s → %s', (before, after) => {
  const s = makeSnapshot(); s.entries[0].locked = true; s.requirements.startDate = before;
  blocked(s, [{ kind: 'requirements', value: { ...s.requirements, startDate: after } }], 'LOCKED_ENTRY');
});
test('未鎖行程可改日期', () => {
  const s = makeSnapshot();
  const result = propose(s, [{ kind: 'requirements', value: { ...s.requirements, startDate: '2026-10-01' } }]);
  expect(result.canApply).toBe(true);
  expect(result.next.requirements.startDate).toBe('2026-10-01');
});
test('鎖定單價與來源可依新旅客數重算，不把總人數算入鎖', () => {
  const s = makeSnapshot(); s.entries[1].locked = true;
  const result = propose(s, [{ kind: 'requirements', value: { ...s.requirements, people: 1 } }]);
  expect(result.canApply).toBe(true);
  expect(result.budget.knownMinor).toBe(380000);
  expect(result.next.entries[1]).toEqual(s.entries[1]);
});
test('鎖定住宿四人一房回傳 CAPACITY，不崩潰也不暗加房', () => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  const result = blocked(s, [{ kind: 'requirements', value: { ...s.requirements, people: 4 } }], 'CAPACITY');
  expect(result.next.entries[0].rooms).toBe(1);
  expect(result.budget.withinBudget).toBeNull();
});
test('四人明確改兩房可套用', () => {
  const s = makeSnapshot();
  const result = propose(s, [{ kind: 'requirements', value: { ...s.requirements, people: 4 } }, { kind: 'rooms', entryId: 'stay', rooms: 2 }]);
  expect(result.canApply).toBe(true);
  expect(result.budget.knownMinor).toBe(830000);
});
test('下午留白：移除活動，不自動補其他活動', () => {
  const result = propose(makeSnapshot(), [{ kind: 'remove', entryId: 'transfer' }]);
  expect(result.canApply).toBe(true);
  expect(result.next.entries.map(e => e.id)).toEqual(['stay', 'tour']);
});
test('活動同族群同時段衝突', () => {
  blocked(makeSnapshot(), [{ kind: 'move', entryId: 'transfer', day: 2, slot: 'morning' }], 'OVERLAP');
});
test.each([['divers', 'non-divers', 1], ['divers', 'all', 0]] as const)('無共同參與者 %s/%s 可同時', (a, b, divers) => {
  const s = makeSnapshot(); s.entries[1].item.audience = a; s.entries[2].item.audience = b; s.requirements.divers = divers;
  expect(propose(s, [{ kind: 'move', entryId: 'transfer', day: 2, slot: 'morning' }]).canApply).toBe(true);
});
test('住宿不與活動判定重疊', () => {
  expect(propose(makeSnapshot(), [{ kind: 'move', entryId: 'tour', day: 1, slot: 'evening' }]).canApply).toBe(true);
});
test('未知費用只警告且不宣稱可負擔', () => {
  const s = makeSnapshot(); Object.assign(s.entries[1].item.price, { unitMinor: null, unknownReason: '待報價' });
  const result = propose(s, []);
  expect(result.canApply).toBe(true);
  expect(result.budget).toEqual({ knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COST', entryId: 'tour' }));
});
test('exclusions 保留並警告', () => {
  const s = makeSnapshot(); s.exclusions = ['餐費未計'];
  const result = propose(s, []);
  expect(result.canApply).toBe(true);
  expect(result.next.exclusions).toEqual(['餐費未計']);
  expect(result.budget.withinBudget).toBeNull();
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'EXCLUDED_COST' }));
});
test.each([false, true])('預算無解保留提案，未知費用=%s 也不能蓋掉已知超支', unknown => {
  const s = makeSnapshot(); s.exclusions = ['餐費'];
  if (unknown) Object.assign(s.entries[1].item.price, { unitMinor: null, unknownReason: '待報價' });
  const result = blocked(s, [{ kind: 'requirements', value: { ...s.requirements, budgetMinor: 100 } }], 'BUDGET_EXCEEDED');
  expect(result.next.requirements.budgetMinor).toBe(100);
});
test('add 與 replace 從 server catalog 深複製價格與來源', () => {
  const s = makeSnapshot(); const catalog = catalogOf(s);
  const item: CatalogItem = { ...structuredClone(catalog[1]), id: 'new', title: 'DEMO new' }; catalog.push(item);
  const changes: Change[] = [{ kind: 'replace', entryId: 'tour', catalogId: 'new' }, { kind: 'add', entry: { id: 'extra', catalogId: 'new', day: 3, slot: 'morning', rooms: null, endDay: null } }];
  const result = propose(s, changes, 'agent', catalog);
  expect(result.canApply).toBe(true);
  expect(result.next.entries[1].item).toEqual(item);
  expect(result.next.entries[3]).toMatchObject({ locked: false, item });
  item.price.unitMinor = 1; item.sources[0].label = 'tampered';
  expect(result.next.entries[3].item.price.unitMinor).toBe(50000);
  result.next.entries[0].item.sources[0].label = 'mutated';
  expect(s.entries[0].item.sources[0].label).toContain('DEMO');
  changes[0] = { kind: 'remove', entryId: 'stay' };
  expect(result.changes[0].kind).toBe('replace');
});
test('相同項目 canonical key 順序不構成鎖定修改', () => {
  const s = makeSnapshot(); s.entries[1].locked = true;
  const catalog = catalogOf(s); catalog[1] = Object.fromEntries(Object.entries(catalog[1]).reverse()) as CatalogItem;
  expect(propose(s, [{ kind: 'replace', entryId: 'tour', catalogId: 'tour' }], 'agent', catalog).canApply).toBe(true);
});
test.each(['price', 'source'] as const)('相同 catalog ID 更新 %s 不可改掉鎖定依據', field => {
  const s = makeSnapshot(); s.entries[1].locked = true;
  const catalog = catalogOf(s);
  if (field === 'price') catalog[1].price.unitMinor = 1;
  else catalog[1].sources[0].label = 'DEMO 新來源';
  blocked(s, [{ kind: 'replace', entryId: 'tour', catalogId: 'tour' }], 'LOCKED_ENTRY', 'agent', catalog);
  expect(propose(s, [], 'agent', catalog).next.entries[1].item).toEqual(s.entries[1].item);
});

// Catches permissive parsing, missing references, invalid quantities and date bounds.
const badChanges: [string, unknown, string][] = [
  ['client snapshot', [{ kind: 'add', entry: { id: 'x', catalogId: 'tour', day: 3, slot: 'morning', rooms: null, endDay: null, item: {} } }], 'INVALID_CHANGE'],
  ['client lock', [{ kind: 'add', entry: { id: 'x', catalogId: 'tour', day: 3, slot: 'morning', rooms: null, endDay: null, locked: true } }], 'INVALID_CHANGE'],
  ['actor payload', [{ kind: 'remove', entryId: 'tour', actor: 'user' }], 'INVALID_CHANGE'],
  ['exclusions payload', [{ kind: 'exclusions', value: [] }], 'INVALID_CHANGE'],
  ['missing item', [{ kind: 'replace', entryId: 'tour', catalogId: 'absent' }], 'CATALOG_NOT_FOUND'],
  ['missing entry', [{ kind: 'remove', entryId: 'absent' }], 'ENTRY_NOT_FOUND'],
  ['duplicate', [{ kind: 'add', entry: { id: 'tour', catalogId: 'tour', day: 3, slot: 'morning', rooms: null, endDay: null } }], 'DUPLICATE_ENTRY'],
  ['out of bounds', [{ kind: 'move', entryId: 'tour', day: 5, slot: 'morning' }], 'DATE_OUT_OF_RANGE'],
  ['zero nights', [{ kind: 'move', entryId: 'stay', day: 4, slot: 'evening' }], 'INVALID_LODGING'],
  ['activity rooms', [{ kind: 'rooms', entryId: 'tour', rooms: 2 }], 'INVALID_LODGING'],
  ['zero rooms', [{ kind: 'rooms', entryId: 'stay', rooms: 0 }], 'INVALID_CHANGE'],
  ['fractional rooms', [{ kind: 'rooms', entryId: 'stay', rooms: 1.5 }], 'INVALID_CHANGE'],
  ['unsafe rooms', [{ kind: 'rooms', entryId: 'stay', rooms: Number.MAX_SAFE_INTEGER + 1 }], 'INVALID_CHANGE'],
  ['invalid slot', [{ kind: 'move', entryId: 'tour', day: 2, slot: 'midnight' }], 'INVALID_CHANGE'],
];
test.each(badChanges)('拒絕 %s', (_, changes, code) => { blocked(makeSnapshot(), changes as Change[], code); });
test('strict requirements 拒絕偷渡 exclusions，整批不處理', () => {
  const s = makeSnapshot();
  const result = blocked(s, [{ kind: 'remove', entryId: 'tour' }, { kind: 'requirements', value: { ...s.requirements, exclusions: [] } } as unknown as Change], 'INVALID_CHANGE');
  expect(result.next).toEqual(s);
});
test.each(['green-island', null] as const)('目的地 %s 不可混入小琉球項目', destinationId => {
  const s = makeSnapshot();
  blocked(s, [{ kind: 'requirements', value: { ...s.requirements, destinationId } }], 'DESTINATION_MISMATCH');
});
test('無效 runtime actor 不能修改鎖定', () => {
  const s = makeSnapshot(); s.entries[0].locked = true;
  blocked(s, [{ kind: 'lock', entryId: 'stay', locked: false }], 'INVALID_ACTOR', 'admin' as 'user');
});
test('計費溢位回傳結構化衝突', () => {
  const s = makeSnapshot(); const catalog = catalogOf(s); catalog[1].price.unitMinor = Number.MAX_SAFE_INTEGER;
  blocked(s, [{ kind: 'replace', entryId: 'tour', catalogId: 'tour' }], 'BUDGET_INVALID', 'agent', catalog);
});

test('容量不足仍計原房數費用，已知超支也會阻擋', () => {
  const s = makeSnapshot();
  const result = blocked(s, [{ kind: 'requirements', value: { ...s.requirements, people: 4, budgetMinor: 500000 } }], 'CAPACITY');
  expect(result.budget.knownMinor).toBe(530000);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
  expect(result.issues.some(i => i.code === 'BUDGET_INVALID')).toBe(false);
});
test('容量不足且價格未知，仍保留未知費用警告', () => {
  const s = makeSnapshot(); Object.assign(s.entries[0].item.price, { unitMinor: null, unknownReason: '待報價' });
  const result = blocked(s, [{ kind: 'requirements', value: { ...s.requirements, people: 4 } }], 'CAPACITY');
  expect(result.budget).toEqual({ knownMinor: 230000, unknownEntryIds: ['stay'], withinBudget: null });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COST', entryId: 'stay' }));
});
test('日期平移加反向 day 調整仍不可改鎖定快照', () => {
  const s = makeSnapshot(); s.requirements.startDate = '2026-09-19'; s.entries[1].locked = true;
  blocked(s, [{ kind: 'requirements', value: { ...s.requirements, startDate: '2026-09-20' } }, { kind: 'move', entryId: 'tour', day: 1, slot: 'morning' }], 'LOCKED_ENTRY');
});
test('移除再用相同 ID 加回不能洗掉鎖定', () => {
  const s = makeSnapshot(); s.entries[1].locked = true;
  blocked(s, [{ kind: 'remove', entryId: 'tour' }, { kind: 'add', entry: { id: 'tour', catalogId: 'tour', day: 2, slot: 'morning', rooms: null, endDay: null } }], 'LOCKED_ENTRY');
});
test('鎖定住宿縮日之外的有效縮日可行', () => {
  const s = makeSnapshot(); s.entries[0].endDay = 3; s.entries[0].locked = true;
  const result = propose(s, [{ kind: 'requirements', value: { ...s.requirements, days: 3 } }]);
  expect(result.canApply).toBe(true);
  expect(result.next.requirements.days).toBe(3);
});
test('跨目的地 catalog add 不可混入', () => {
  const s = makeSnapshot(); const catalog = catalogOf(s);
  catalog.push({ ...structuredClone(catalog[1]), id: 'foreign', destinationId: 'kenting' });
  blocked(s, [{ kind: 'add', entry: { id: 'new', catalogId: 'foreign', day: 3, slot: 'morning', rooms: null, endDay: null } }], 'DESTINATION_MISMATCH', 'agent', catalog);
});
test('重複 catalog ID 拒絕整批，不選任意價格', () => {
  const s = makeSnapshot(); const catalog = catalogOf(s); catalog.push(structuredClone(catalog[0]));
  const result = blocked(s, [{ kind: 'remove', entryId: 'tour' }], 'INVALID_CATALOG', 'agent', catalog);
  expect(result.next).toEqual(s);
});
test('精確預算上限可套用，輸入及輸出完全分離', () => {
  const s = makeSnapshot(); const original = structuredClone(s); const catalog = catalogOf(s);
  const changes: Change[] = [{ kind: 'requirements', value: { ...s.requirements, budgetMinor: 430000 } }];
  const result = propose(s, changes, 'agent', catalog);
  expect(result.canApply).toBe(true);
  expect(result.budget.withinBudget).toBe(true);
  result.next.requirements.people = 6; result.next.exclusions.push('mutated');
  expect(s).toEqual(original);
  expect(changes[0]).toMatchObject({ kind: 'requirements', value: { people: 2 } });
  expect(catalog).toEqual(catalogOf(original));
});
