import type { DestinationId, Slot } from './types';

/** Explicit publication contract: never spread a private snapshot into this. */
export type PublicTrip = {
  destinationId: DestinationId | null; days: number; people: number;
  budget: { knownMinor: number; limitMinor: number | null; unknownCount: number; exclusionsCount: number };
  entries: {
    day: number; slot: Slot; endDay: number | null; rooms: number | null;
    title: string; kind: 'lodging' | 'activity'; demo: boolean; sourceVerified: boolean;
    price: { unit: 'person' | 'room-night' | 'group'; unitMinor: number | null; basis: 'estimate' | 'demo' };
    sources: { url: string | null; label: string; checkedAt: string; kind: 'fact' | 'demo' }[];
  }[];
};
