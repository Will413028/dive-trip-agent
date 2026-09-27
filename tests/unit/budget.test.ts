import { expect, test } from 'vitest';
import { assessLockedBudget, calculateBudget } from '../../src/domain/budget';
import { makeSnapshot } from '../support/domain-fixtures';
import type { Snapshot } from '../../src/domain/types';

// Catches unknown costs treated as free and incorrect fixture arithmetic.
test('未知不是免費，不能聲稱預算達標', () => {
  const s = makeSnapshot();
  expect(calculateBudget(s).knownMinor).toBe(430000);
  s.entries[1].item.price.unitMinor = null;
  s.entries[1].item.price.unknownReason = '待業者確認';
  expect(calculateBudget(s)).toEqual({ knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null });
});

test('fixture 每次獨立，計算不修改輸入', () => {
  const s = makeSnapshot();
  const original = structuredClone(s);
  expect(calculateBudget(s)).toEqual({ knownMinor: 430000, unknownEntryIds: [], withinBudget: true });
  expect(s).toEqual(original);
  s.entries[0].item.sources[0].label = 'changed';
  s.requirements.people = 1;
  s.exclusions.push('餐費');
  expect(makeSnapshot()).toEqual(original);
});

// Literal totals catch wrong audience, room count, nights, or group multiplication.
test.each([
  ['all', 3, 1, 150000], ['divers', 3, 1, 50000], ['non-divers', 3, 1, 100000],
  ['divers', 2, 0, 0], ['non-divers', 2, 2, 0],
] as const)('%s 人數 %i／潛水 %i 的 person 費用', (audience, people, divers, total) => {
  const s = makeSnapshot();
  s.entries = [s.entries[1]];
  Object.assign(s.requirements, { people, divers });
  s.entries[0].item.audience = audience;
  expect(calculateBudget(s).knownMinor).toBe(total);
});

test('房間 × 住宿夜數；不按總行程日數計費', () => {
  const s = makeSnapshot();
  s.entries = [s.entries[0]];
  Object.assign(s.entries[0], { rooms: 2, day: 2, endDay: 4 });
  s.requirements.people = 4;
  expect(calculateBudget(s).knownMinor).toBe(400000);
});

test('group 固定一次，即使 audience 沒有參與者', () => {
  const s = makeSnapshot();
  s.entries = [s.entries[2]];
  s.entries[0].item.audience = 'divers';
  s.requirements.divers = 0;
  expect(calculateBudget(s).knownMinor).toBe(30000);
});

test.each(['divers', 'non-divers'] as const)('未知 person 價格、0 位 %s 為已知 0', (audience) => {
  const s = makeSnapshot();
  s.entries = [s.entries[1]];
  s.requirements.divers = audience === 'divers' ? 0 : 2;
  s.entries[0].item.audience = audience;
  Object.assign(s.entries[0].item.price, { unitMinor: null, unknownReason: '未報價' });
  expect(calculateBudget(s)).toEqual({ knownMinor: 0, unknownEntryIds: [], withinBudget: true });
});

test.each([430000, 429999, null] as const)('預算比較 %s', (budgetMinor) => {
  const s = makeSnapshot();
  s.requirements.budgetMinor = budgetMinor;
  expect(calculateBudget(s).withinBudget).toBe(budgetMinor === null ? null : budgetMinor === 430000);
});

test('excluded 費用不扣除已知費用，但不能宣稱預算達標', () => {
  const s = makeSnapshot();
  s.exclusions = ['餐費尚未納入'];
  expect(calculateBudget(s)).toEqual({ knownMinor: 430000, unknownEntryIds: [], withinBudget: null });
});

const invalid: [string, (s: Snapshot) => void][] = [
  ['人數 0', s => { s.requirements.people = 0; }],
  ['人數 7', s => { s.requirements.people = 7; }],
  ['小數人數', s => { s.requirements.people = 1.5; }],
  ['潛水超額', s => { s.requirements.divers = 3; }],
  ['負潛水人數', s => { s.requirements.divers = -1; }],
  ['0 房', s => { s.entries[0].rooms = 0; }],
  ['負房數', s => { s.entries[0].rooms = -1; }],
  ['小數房', s => { s.entries[0].rooms = 1.5; }],
  ['缺房數', s => { s.entries[0].rooms = null; }],
  ['無限房數', s => { s.entries[0].rooms = Infinity; }],
  ['不安全房數', s => { s.entries[0].rooms = Number.MAX_SAFE_INTEGER + 1; }],
  ['零晚', s => { s.entries[0].endDay = 1; }],
  ['倒序夜數', s => { s.entries[0].day = 3; s.entries[0].endDay = 2; }],
  ['缺退房日', s => { s.entries[0].endDay = null; }],
  ['越界退房', s => { s.entries[0].endDay = 5; }],
  ['小數日期', s => { s.entries[0].day = 1.5; }],
  ['活動越界', s => { s.entries[1].day = 0; }],
  ['活動夾帶房數', s => { s.entries[1].rooms = 1; }],
  ['活動夾帶退房日', s => { s.entries[1].endDay = 3; }],
  ['容量不足', s => { s.requirements.people = 3; }],
  ['容量為 0', s => { s.entries[0].item.capacityPerRoom = 0; }],
  ['容量小數', s => { s.entries[0].item.capacityPerRoom = 1.5; }],
  ['容量未知', s => { s.entries[0].item.capacityPerRoom = null; }],
  ['未知價也驗數量', s => { Object.assign(s.entries[0].item.price, { unitMinor: null, unknownReason: '未知' }); s.entries[0].rooms = 0; }],
  ['負單價', s => { s.entries[1].item.price.unitMinor = -1; }],
  ['小數單價', s => { s.entries[1].item.price.unitMinor = 0.5; }],
  ['非有限單價', s => { s.entries[1].item.price.unitMinor = NaN; }],
  ['不安全單價', s => { s.entries[1].item.price.unitMinor = Number.MAX_SAFE_INTEGER + 1; }],
  ['乘積溢位', s => { s.entries[1].item.price.unitMinor = Number.MAX_SAFE_INTEGER; }],
  ['總額溢位', s => { s.entries[2].item.price.unitMinor = Number.MAX_SAFE_INTEGER; }],
  ['容量乘積溢位', s => { s.entries[0].rooms = Number.MAX_SAFE_INTEGER; s.entries[0].endDay = 2; }],
  ['不安全預算', s => { s.requirements.budgetMinor = Number.MAX_SAFE_INTEGER + 1; }],
];

test('房晚數溢位獨立於容量與價格檢查', () => {
  const s = makeSnapshot();
  s.entries[0].rooms = Number.MAX_SAFE_INTEGER;
  s.entries[0].item.capacityPerRoom = 1;
  s.entries[0].item.price.unitMinor = 0;
  // Capacity remains safe; three nights overflow even with a zero unit price.
  expect(() => calculateBudget(s)).toThrow('房晚數 必須為 >= 1 的安全整數');
  s.entries[0].endDay = 2;
  expect(calculateBudget(s).knownMinor).toBe(130000);
});

test.each(invalid)('拒絕非法數量／容量／金額：%s', (_, mutate) => {
  const s = makeSnapshot();
  mutate(s);
  const before = structuredClone(s);
  expect(() => calculateBudget(s)).toThrow();
  expect(s).toEqual(before);
});

test('安全整數上限與零價可正常比較', () => {
  const s = makeSnapshot();
  s.entries = [s.entries[2]];
  s.requirements.budgetMinor = Number.MAX_SAFE_INTEGER;
  s.entries[0].item.price.unitMinor = Number.MAX_SAFE_INTEGER;
  expect(calculateBudget(s)).toEqual({ knownMinor: Number.MAX_SAFE_INTEGER, unknownEntryIds: [], withinBudget: true });
  s.entries[0].item.price.unitMinor = 0;
  s.requirements.budgetMinor = 0;
  expect(calculateBudget(s)).toEqual({ knownMinor: 0, unknownEntryIds: [], withinBudget: true });
});

test('domain owns candidate eligibility for a locked lower bound, including unknown future issue codes', () => {
  const base = makeSnapshot(); base.entries[0].locked = true;
  const candidate = structuredClone(base); candidate.requirements.budgetMinor = 10000;
  const before = structuredClone({ base, candidate });
  expect(assessLockedBudget(base, candidate, [{ code: 'BUDGET_EXCEEDED', message: 'budget' }])).toMatchObject({
    status: 'locked-known-cost-exceeds-budget', lockedKnownMinor: 300000, targetBudgetMinor: 10000,
    lockedEntryIds: ['stay'], unknownLockedEntryIds: [],
  });
  for (const code of ['LOCKED_ENTRY', 'CAPACITY', 'BUDGET_INVALID', 'FUTURE_UNKNOWN_RULE']) {
    expect(assessLockedBudget(base, candidate, [{ code, message: 'invalid' }])).toMatchObject({
      status: 'unavailable', lockedKnownMinor: null, targetBudgetMinor: null, unknownLockedEntryIds: null,
    });
  }
  expect({ base, candidate }).toEqual(before);
});

test('unknown locked prices and unspecified targets are not silently converted to feasibility', () => {
  const base = makeSnapshot(); base.entries[0].locked = true;
  Object.assign(base.entries[0].item.price, { unitMinor: null, unknownReason: '待查' });
  expect(assessLockedBudget(base, base, [{ code: 'UNKNOWN_COST', message: 'unknown' }])).toMatchObject({
    status: 'not-proven-infeasible', lockedKnownMinor: 0, unknownLockedEntryIds: ['stay'],
  });
  const candidate = structuredClone(base); candidate.requirements.budgetMinor = null;
  expect(assessLockedBudget(base, candidate).status).toBe('budget-unspecified');
  candidate.entries[0].rooms = 2;
  expect(assessLockedBudget(base, candidate).lockedEntryIds).toEqual(['stay']);
});
