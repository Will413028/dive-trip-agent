// The backend owns contract shapes; this path remains for existing UI imports.
// Entry.item is a server-bound immutable catalog snapshot. Budget.withinBudget
// stays null for an unset limit, unknown prices, or nonempty exclusions.
export type {
  DestinationId, Slot, Source, Requirements, Price, CatalogItem, Entry, Snapshot,
  Budget, Issue, Change, ProposalDraft, TripView,
} from '../contracts/generated';
