import { expect, test } from 'vitest';
import { parseRequirements } from '../../src/domain/schemas';
import { DomainError } from '../../src/domain/errors';

const input = {
  destinationId: null, days: 4, people: 2, divers: 1,
  startDate: null, budgetMinor: null, lodgingPreference: '舒適', pace: 'relaxed',
};

// Catch rejecting undetermined dates, losing fields, or inventing a zero budget.
test('保留日期、目的地與預算未定，以及所有需求欄位', () => {
  expect(parseRequirements(input)).toEqual({
    destinationId: null, days: 4, people: 2, divers: 1,
    startDate: null, budgetMinor: null, lodgingPreference: '舒適', pace: 'relaxed',
  });
});

test('接受日期未定，拒絕不合法人數與潛水人數', () => {
  expect(parseRequirements(input).startDate).toBeNull();
  expect(() => parseRequirements({ ...input, people: 7 })).toThrow();
  expect(() => parseRequirements({ ...input, divers: 3 })).toThrow();
});

// Catch off-by-one bounds, dropped enum values, and incorrect leap-year handling.
test.each([
  { destinationId: 'xiaoliuqiu', days: 2, people: 1, divers: 0, startDate: '2028-02-29', budgetMinor: 0, pace: 'balanced' },
  { destinationId: 'green-island', days: 7, people: 6, divers: 6, startDate: '2000-02-29', budgetMinor: 120000, pace: 'relaxed' },
  { destinationId: 'kenting', days: 4, people: 2, divers: 1, startDate: '2026-12-31', budgetMinor: 1, pace: 'balanced' },
])('接受合法邊界：%j', (fields) => {
  expect(parseRequirements({ ...input, ...fields })).toEqual({
    ...fields, lodgingPreference: '舒適',
  });
});

// Each literal catches removal of its validation rule; no coercion is allowed.
test.each([
  ['days', 1], ['days', 8], ['days', 2.5], ['days', NaN], ['days', Infinity], ['days', '4'],
  ['people', 0], ['people', 7], ['people', 1.5], ['people', NaN], ['people', Infinity], ['people', '2'],
  ['divers', -1], ['divers', 3], ['divers', 0.5], ['divers', NaN], ['divers', Infinity], ['divers', '1'],
  ['budgetMinor', -1], ['budgetMinor', 1.5], ['budgetMinor', NaN], ['budgetMinor', Infinity], ['budgetMinor', '100'],
  ['destinationId', 'okinawa'], ['destinationId', 1],
  ['pace', 'fast'], ['pace', null],
  ['lodgingPreference', null], ['lodgingPreference', 1],
  ['startDate', '2026-02-29'], ['startDate', '1900-02-29'], ['startDate', '2026-04-31'],
  ['startDate', '2026-00-01'], ['startDate', '2026-13-01'], ['startDate', '2026-01-00'],
  ['startDate', '2026-01-32'], ['startDate', '2026-2-01'], ['startDate', 'not-a-date'],
  ['startDate', '2026-09-19T00:00:00Z'], ['startDate', ''], ['startDate', 20260919],
])('拒絕 %s 的非法值 %s', (field, value) => {
  expect(() => parseRequirements({ ...input, [field]: value })).toThrow();
});

test.each(Object.keys(input))('拒絕遺漏必要欄位 %s', (field) => {
  const incomplete: Record<string, unknown> = { ...input };
  delete incomplete[field];
  expect(() => parseRequirements(incomplete)).toThrow();
});

test.each([null, undefined, [], 'requirements', 4].map((value) => [value]))('拒絕非需求物件 %j', (value) => {
  expect(() => parseRequirements(value)).toThrow();
});

test('拒絕未知欄位，不能靜默丟棄', () => {
  expect(() => parseRequirements({ ...input, untrusted: true })).toThrow();
});

// Catch lost/defaulted error codes and messages used by domain error consumers.
test('DomainError 以 code 作為預設 message，並可由 Error 捕捉', () => {
  const error = new DomainError('INVALID_REQUIREMENTS');
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('INVALID_REQUIREMENTS');
  expect(error.message).toBe('INVALID_REQUIREMENTS');
});

test('DomainError 保留自訂 message 與原始 code', () => {
  const error = new DomainError('LOCKED_ENTRY', '此項目已鎖定');
  expect(error.code).toBe('LOCKED_ENTRY');
  expect(error.message).toBe('此項目已鎖定');
});
