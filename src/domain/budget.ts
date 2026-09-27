import { loadCatalog } from '../catalog/catalog.ts';
import { parseRequirements } from './schemas.ts';
import type { Entry, Requirements } from './types.ts';
import type { Budget, Issue, Snapshot } from './types.ts';

function integer(value: number | null, minimum: number, label: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} 必須為 >= ${minimum} 的安全整數`);
  }
  return value;
}

function quantity(entry: Entry, requirements: Requirements): number {
  const day = integer(entry.day, 1, '開始日');
  if (day > requirements.days) throw new RangeError('開始日超出行程');
  const participants = entry.item.audience === 'all' ? requirements.people
    : entry.item.audience === 'divers' ? requirements.divers : requirements.people - requirements.divers;
  if (entry.item.price.unit === 'room-night') {
    const rooms = integer(entry.rooms, 1, '房間數');
    const endDay = integer(entry.endDay, day + 1, '退房日');
    if (endDay > requirements.days) throw new RangeError('退房日超出行程');
    const capacity = integer(entry.item.capacityPerRoom, 1, '每房容量');
    const totalCapacity = integer(rooms * capacity, 1, '房間總容量');
    if (totalCapacity < participants) throw new RangeError('住宿容量不足，請明確調整房間數');
    return integer(rooms * (endDay - day), 1, '房晚數');
  }
  if (entry.rooms !== null || entry.endDay !== null) throw new RangeError('活動不可帶房間数或退房日');
  return entry.item.price.unit === 'group' ? 1 : participants;
}

export function calculateBudget(snapshot: Snapshot): Budget {
  const requirements = parseRequirements(snapshot.requirements);
  // Validate every quantity before processing known or unknown costs.
  const entries = snapshot.entries.map(entry => {
    const item = loadCatalog([entry.item])[0];
    return { entry, item, quantity: quantity({ ...entry, item }, requirements) };
  });
  let knownMinor = 0;
  const unknownEntryIds: string[] = [];
  for (const { entry, item, quantity } of entries) {
    // No participant means no cost, even when the unit price is unavailable.
    if (quantity === 0) continue;
    if (item.price.unitMinor === null) {
      unknownEntryIds.push(entry.id);
    } else {
      const cost = integer(item.price.unitMinor * quantity, 0, '項目費用');
      knownMinor = integer(knownMinor + cost, 0, '總費用');
    }
  }
  const comparable = requirements.budgetMinor !== null && unknownEntryIds.length === 0 && snapshot.exclusions.length === 0;
  return {
    knownMinor,
    unknownEntryIds,
    withinBudget: comparable ? knownMinor <= requirements.budgetMinor! : null,
  };
}

export type LockedBudgetAssessment = {
  status: 'unavailable' | 'budget-unspecified' | 'locked-known-cost-exceeds-budget' | 'not-proven-infeasible';
  targetBudgetMinor: number | null; lockedKnownMinor: number | null;
  lockedEntryIds: string[]; unknownLockedEntryIds: string[] | null;
  excludedCostsPresent: boolean; scope: 'candidate-requirements-original-locked-entries';
};

/** One domain assessment for tools and all presentation projections. Exceeding
 * budget does not invalidate valuation; structural/authorization issues do.
 * This is a lower bound over original locked entries, not an optimizer. */
export function assessLockedBudget(base: Snapshot, candidate: Snapshot, issues: Issue[] = []): LockedBudgetAssessment {
  const lockedEntryIds = base.entries.filter(entry => entry.locked).map(entry => entry.id);
  const unavailable: LockedBudgetAssessment = { status: 'unavailable', targetBudgetMinor: null, lockedKnownMinor: null,
    lockedEntryIds, unknownLockedEntryIds: null, excludedCostsPresent: candidate.exclusions.length > 0,
    scope: 'candidate-requirements-original-locked-entries' };
  if (!issues.every(issue => ['BUDGET_EXCEEDED', 'UNKNOWN_COST', 'EXCLUDED_COST'].includes(issue.code))) return unavailable;
  try {
    const locked = { ...candidate, entries: base.entries.filter(entry => entry.locked) };
    const budget = calculateBudget(locked), target = candidate.requirements.budgetMinor;
    return { ...unavailable, status: target === null ? 'budget-unspecified'
      : budget.knownMinor > target ? 'locked-known-cost-exceeds-budget' : 'not-proven-infeasible',
      targetBudgetMinor: target, lockedKnownMinor: budget.knownMinor, unknownLockedEntryIds: budget.unknownEntryIds };
  } catch { return unavailable; }
}
