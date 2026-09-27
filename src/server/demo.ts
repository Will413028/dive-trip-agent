import data from '../../data/catalog.json';
import { loadCatalog } from '../catalog/catalog';
import { makeSnapshot } from '../catalog/demo-fixtures';
import type { CatalogItem, TripView } from '../domain/types';
import { createTrip } from './trip-store';

export function catalog(): CatalogItem[] { return loadCatalog(data); }

export const demoScenarios = ['normal', 'budget-conflict', 'lookup-failure'] as const;
export type DemoScenario = typeof demoScenarios[number];

export async function createDemo(ownerId: string, scenario: DemoScenario): Promise<TripView> {
  if (!demoScenarios.includes(scenario)) throw new Error('UNKNOWN_SCENARIO');
  const snapshot = makeSnapshot();
  const items = new Map(catalog().map(item => [item.id, item]));
  snapshot.entries.forEach(entry => { entry.item = items.get(entry.catalogId)!; });
  if (scenario === 'budget-conflict') {
    snapshot.entries.find(entry => entry.id === 'stay')!.locked = true;
    // Keep version 1 valid. The landing submits the lower budget as a blocked
    // proposal, never as a persisted trip snapshot.
    snapshot.requirements.budgetMinor = 430000;
  }
  // lookup-failure is a static fixture illustration on the landing, not an
  // agent/provider fault selector. Every scenario creates a fresh owned trip.
  return createTrip(ownerId, snapshot);
}
