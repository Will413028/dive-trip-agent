import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calculateBudget } from '../domain/budget';
import { DomainError } from '../domain/errors';
import { parseSnapshot } from '../domain/snapshot';
import type { Snapshot, TripView } from '../domain/types';
import { database, transaction } from './db';

export async function createTrip(ownerId: string, input: Snapshot): Promise<TripView> {
  if (!z.uuid().safeParse(ownerId).success) throw new DomainError('NOT_FOUND');
  let snapshot: Snapshot;
  try { snapshot = parseSnapshot(input); }
  catch { throw new DomainError('INVALID_SNAPSHOT'); }
  return transaction(database(), async client => {
    const owner = await client.query(
      'SELECT id FROM sessions WHERE id = $1 AND expires_at > clock_timestamp() FOR SHARE', [ownerId],
    );
    if (!owner.rowCount) throw new DomainError('NOT_FOUND');
    // A lock-only waiter is not guaranteed to re-evaluate the original TTL.
    const liveOwner = await client.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>clock_timestamp()', [ownerId]);
    if (!liveOwner.rowCount) throw new DomainError('NOT_FOUND');
    const id = randomUUID();
    await client.query('INSERT INTO trips (id, owner_id, current_version) VALUES ($1, $2, 1)', [id, ownerId]);
    await client.query('INSERT INTO trip_versions (trip_id, version, snapshot) VALUES ($1, 1, $2::jsonb)', [id, JSON.stringify(snapshot)]);
    return { id, version: 1, snapshot, budget: calculateBudget(snapshot) };
  });
}

export async function getTrip(ownerId: string, tripId: string): Promise<TripView | null> {
  if (![ownerId, tripId].every(id => z.uuid().safeParse(id).success)) return null;
  const result = await database().query<{ id: string; current_version: number; snapshot: unknown }>(`
    SELECT t.id, t.current_version, v.snapshot FROM trips t
    JOIN sessions s ON s.id = t.owner_id
    JOIN trip_versions v ON v.trip_id = t.id AND v.version = t.current_version
    WHERE t.id = $1 AND t.owner_id = $2 AND t.expires_at > now() AND s.expires_at > now()
  `, [tripId, ownerId]);
  const row = result.rows[0];
  if (!row) return null;
  let snapshot: Snapshot;
  try { snapshot = parseSnapshot(row.snapshot); }
  catch { throw new DomainError('CORRUPT_SNAPSHOT'); }
  return { id: row.id, version: row.current_version, snapshot, budget: calculateBudget(snapshot) };
}
