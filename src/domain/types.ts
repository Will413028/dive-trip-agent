export type DestinationId = 'xiaoliuqiu' | 'green-island' | 'kenting';
export type Slot = 'morning' | 'afternoon' | 'evening';
export type Source = {
  id: string; url: string | null; checkedAt: string;
  kind: 'fact' | 'demo'; label: string;
};
export type Requirements = {
  destinationId: DestinationId | null; days: number;
  people: number; divers: number; startDate: string | null;
  budgetMinor: number | null; lodgingPreference: string; pace: 'relaxed' | 'balanced';
};
export type Price = {
  unit: 'person' | 'room-night' | 'group'; unitMinor: number | null;
  basis: 'estimate' | 'demo'; sourceId: string; unknownReason: string | null;
};
export type CatalogItem = {
  id: string; destinationId: DestinationId; kind: 'lodging' | 'activity';
  title: string; audience: 'all' | 'divers' | 'non-divers';
  capacityPerRoom: number | null; lat: number | null; lng: number | null;
  price: Price; sources: Source[];
};
export type Entry = {
  id: string; catalogId: string; day: number; slot: Slot;
  endDay: number | null; rooms: number | null; locked: boolean;
  item: CatalogItem; // 服務端由 catalog 解析的 immutable snapshot
};
export type Snapshot = {
  requirements: Requirements; entries: Entry[]; exclusions: string[];
};
export type Budget = {
  knownMinor: number; unknownEntryIds: string[];
  withinBudget: boolean | null; // 預算未定、未知費用或 exclusions 非空則 null
};
export type Issue = { code: string; entryId?: string; message: string };
export type Change =
  | { kind: 'requirements'; value: Requirements }
  | { kind: 'add'; entry: Omit<Entry, 'item' | 'locked'> }
  | { kind: 'remove'; entryId: string }
  | { kind: 'move'; entryId: string; day: number; slot: Slot }
  | { kind: 'replace'; entryId: string; catalogId: string }
  | { kind: 'rooms'; entryId: string; rooms: number }
  | { kind: 'lock'; entryId: string; locked: boolean };
export type ProposalDraft = {
  next: Snapshot; budget: Budget; issues: Issue[];
  changes: Change[]; canApply: boolean;
};
export type TripView = { id: string; version: number; snapshot: Snapshot; budget: Budget };
