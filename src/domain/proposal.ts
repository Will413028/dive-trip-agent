import { z } from 'zod';
import { loadCatalog } from '../catalog/catalog.ts';
import { calculateBudget } from './budget.ts';
import { diffSnapshots } from './diff.ts';
import { parseRequirements } from './schemas.ts';
import type { Budget, CatalogItem, Change, Entry, Issue, ProposalDraft, Snapshot } from './types.ts';

const id = z.string().refine(value => value.trim().length > 0, 'ID 不可空白');
const positive = z.number().int().positive();
const slot = z.enum(['morning', 'afternoon', 'evening']);
const requirements = z.unknown().transform((value, context) => {
  try { return parseRequirements(value); }
  catch {
    context.addIssue({ code: 'custom', message: '需求格式無效' });
    return z.NEVER;
  }
});
// Every nested payload is strict. Clients may only express changes, never snapshots or actors.
const changesSchema = z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requirements'), value: requirements }),
  z.strictObject({ kind: z.literal('add'), entry: z.strictObject({
    id, catalogId: id, day: positive, slot, endDay: positive.nullable(), rooms: positive.nullable(),
  }) }),
  z.strictObject({ kind: z.literal('remove'), entryId: id }),
  z.strictObject({ kind: z.literal('move'), entryId: id, day: positive, slot }),
  z.strictObject({ kind: z.literal('replace'), entryId: id, catalogId: id }),
  z.strictObject({ kind: z.literal('rooms'), entryId: id, rooms: positive }),
  z.strictObject({ kind: z.literal('lock'), entryId: id, locked: z.boolean() }),
]));

function participants(entry: Entry, snapshot: Snapshot): number {
  const { people, divers } = snapshot.requirements;
  return entry.item.audience === 'all' ? people : entry.item.audience === 'divers' ? divers : people - divers;
}

// Called with trusted server snapshots/catalog and a server-selected actor.
// The API/Agent adapter must never take actor or base from a client payload.

export function buildProposal(base: Snapshot, changes: Change[], catalog: CatalogItem[], actor: 'user' | 'agent'): ProposalDraft {
  const next = structuredClone(base);
  const issues: Issue[] = [];
  let canApply = true;
  const issue = (code: string, message: string, entryId?: string, warning = false) => {
    issues.push({ code, message, ...(entryId === undefined ? {} : { entryId }) });
    if (!warning) canApply = false;
  };
  const parsed = changesSchema.safeParse(changes);
  const accepted: Change[] = parsed.success ? structuredClone(parsed.data) : [];
  if (!parsed.success) issue('INVALID_CHANGE', '修改格式無效；不接受快照、actor、額外欄位或非法數量。');
  if (actor !== 'agent' && actor !== 'user') issue('INVALID_ACTOR', '操作來源必須由服務端指定。');
  const lockChanges = accepted.filter(change => change.kind === 'lock');
  const standaloneLock = actor === 'user' && accepted.length === 1 && lockChanges.length === 1;
  if (lockChanges.length && !standaloneLock) issue('LOCKED_ENTRY', '鎖定／解鎖只允許使用者單獨操作。');
  const catalogResult = (() => {
    try { return loadCatalog(catalog); }
    catch { issue('INVALID_CATALOG', '服務端目錄格式無效。'); return []; }
  })();
  const items = new Map(catalogResult.map(item => [item.id, item]));

  // Reject a malformed or unauthorized batch before applying any of its operations.
  if (canApply) for (const change of accepted) {
    if (change.kind === 'requirements') {
      next.requirements = structuredClone(change.value);
      continue;
    }
    if (change.kind === 'add') {
      if (next.entries.some(entry => entry.id === change.entry.id)) {
        issue('DUPLICATE_ENTRY', '項目 ID 已存在。', change.entry.id);
        continue;
      }
      const item = items.get(change.entry.catalogId);
      if (!item) { issue('CATALOG_NOT_FOUND', '找不到目錄項目。', change.entry.id); continue; }
      next.entries.push({ ...structuredClone(change.entry), locked: false, item: structuredClone(item) });
      continue;
    }
    const entry = next.entries.find(entry => entry.id === change.entryId);
    if (!entry) { issue('ENTRY_NOT_FOUND', '找不到行程項目。', change.entryId); continue; }
    switch (change.kind) {
      case 'remove': next.entries = next.entries.filter(candidate => candidate.id !== entry.id); break;
      case 'move': entry.day = change.day; entry.slot = change.slot; break;
      case 'rooms': entry.rooms = change.rooms; break;
      case 'lock': entry.locked = change.locked; break;
      case 'replace': {
        const item = items.get(change.catalogId);
        if (!item) { issue('CATALOG_NOT_FOUND', '找不到目錄項目。', entry.id); break; }
        entry.catalogId = change.catalogId;
        entry.item = structuredClone(item);
        break;
      }
    }
  }

  // Canonical comparison covers the complete entry, including price and sources.
  // Passenger totals are intentionally outside the locked price basis.
  for (const protectedEntry of base.entries.filter(entry => entry.locked)) {
    const candidate = next.entries.find(entry => entry.id === protectedEntry.id);
    const comparable = candidate && standaloneLock ? { ...candidate, locked: protectedEntry.locked } : candidate;
    const changed = !comparable || diffSnapshots(
      { ...base, entries: [protectedEntry] }, { ...base, entries: [comparable] },
    ).length > 0;
    if (changed || base.requirements.startDate !== next.requirements.startDate
      || protectedEntry.day > next.requirements.days || (protectedEntry.endDay ?? protectedEntry.day) > next.requirements.days
      || protectedEntry.item.destinationId !== next.requirements.destinationId) {
      issue('LOCKED_ENTRY', '已鎖定項目的內容、日期或費用依據不能更動；請先單獨解鎖。', protectedEntry.id);
    }
  }

  const capacityConflicts = new Set<string>();
  const invalidEntries = new Set<string>();
  const ids = new Set<string>();
  for (const entry of next.entries) {
    if (ids.has(entry.id)) issue('DUPLICATE_ENTRY', '項目 ID 不可重複。', entry.id);
    ids.add(entry.id);
    if (!items.has(entry.catalogId)) issue('CATALOG_NOT_FOUND', '目錄項目不存在。', entry.id);
    if (entry.item.destinationId !== next.requirements.destinationId) issue('DESTINATION_MISMATCH', '項目不屬於本趟目的地。', entry.id);
    if (!Number.isSafeInteger(entry.day) || entry.day < 1 || entry.day > next.requirements.days
      || (entry.endDay !== null && entry.endDay > next.requirements.days)) {
      issue('DATE_OUT_OF_RANGE', '項目日期超出行程。', entry.id);
      invalidEntries.add(entry.id);
    }
    if (entry.item.kind === 'lodging') {
      const { rooms, endDay } = entry;
      if (rooms === null || !Number.isSafeInteger(rooms) || rooms < 1
        || endDay === null || !Number.isSafeInteger(endDay) || endDay <= entry.day) {
        issue('INVALID_LODGING', '住宿需正整數房數與有效退房日，至少一晚。', entry.id);
        invalidEntries.add(entry.id);
      } else {
        const capacity = rooms * (entry.item.capacityPerRoom ?? 0);
        if (!Number.isSafeInteger(capacity) || capacity < participants(entry, next)) {
          issue('CAPACITY', '住宿容量不足或容量超出安全整數範圍；請明確調整房間數。', entry.id);
          capacityConflicts.add(entry.id);
        }
      }
    } else if (entry.rooms !== null || entry.endDay !== null) {
      issue('INVALID_LODGING', '活動不可帶房數或退房日。', entry.id);
      invalidEntries.add(entry.id);
    }
  }
  const activities = next.entries.filter(entry => entry.item.kind === 'activity');
  for (let i = 0; i < activities.length; i++) for (let j = i + 1; j < activities.length; j++) {
    const a = activities[i], b = activities[j];
    const commonAudience = a.item.audience === 'all' || b.item.audience === 'all' || a.item.audience === b.item.audience;
    if (a.day === b.day && a.slot === b.slot && commonAudience && participants(a, next) > 0 && participants(b, next) > 0) {
      issue('OVERLAP', `與 ${a.id} 的參與者及時段重疊。`, b.id);
    }
  }

  // Per-entry valuation preserves known costs even when another entry is invalid.
  // Capacity does not alter room-night price: value the requested rooms without adding any.
  let knownMinor = 0;
  const unknownEntryIds: string[] = [];
  let budgetIncomplete = false;
  for (const entry of next.entries) {
    try {
      let cost: Budget;
      if (invalidEntries.has(entry.id)) throw new RangeError('項目日期或住宿數量無效，尚無法完整計價');
      if (capacityConflicts.has(entry.id)) {
        const quantity = entry.rooms! * (entry.endDay! - entry.day);
        const amount = entry.item.price.unitMinor === null ? null : quantity * entry.item.price.unitMinor;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))) {
          throw new RangeError('住宿費用超出安全整數範圍');
        }
        cost = { knownMinor: amount ?? 0, unknownEntryIds: amount === null ? [entry.id] : [], withinBudget: null };
      } else {
        cost = calculateBudget({ ...next, entries: [entry] });
      }
      if (!Number.isSafeInteger(knownMinor + cost.knownMinor)) throw new RangeError('總費用超出安全整數範圍');
      knownMinor += cost.knownMinor;
      unknownEntryIds.push(...cost.unknownEntryIds);
    } catch {
      budgetIncomplete = true;
      issue('BUDGET_INVALID', '此項費用無法安全計算；knownMinor 僅為可計算項目小計。', entry.id);
    }
  }
  const limit = next.requirements.budgetMinor;
  const comparable = !budgetIncomplete && capacityConflicts.size === 0 && limit !== null
    && unknownEntryIds.length === 0 && next.exclusions.length === 0;
  const budget: Budget = { knownMinor, unknownEntryIds, withinBudget: comparable ? knownMinor <= limit! : null };
  if (limit !== null && knownMinor > limit) issue('BUDGET_EXCEEDED', '已知費用已超過預算；請調整需求或行程。');
  for (const entryId of unknownEntryIds) issue('UNKNOWN_COST', '費用待確認，不能宣稱預算足夠。', entryId, true);
  if (next.exclusions.length) issue('EXCLUDED_COST', '仍有未納入費用，不能宣稱預算足夠。', undefined, true);
  return { next, budget, issues, changes: accepted, canApply };
}
