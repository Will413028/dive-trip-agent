import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { calculateBudget } from '../domain/budget';
import { DomainError } from '../domain/errors';
import { parseSnapshot } from '../domain/snapshot';
import type { TripView } from '../domain/types';
import type { PublicTrip } from '../domain/public-trip';
import { database, transaction } from './db';
import { catalog } from './demo';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const version = z.number().int().min(1).max(2147483647);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashPreview(value: PublicTrip): string { return hash(canonical(value)); }

export function previewShare(view: TripView): PublicTrip {
  const snapshot = parseSnapshot(view.snapshot);
  if (snapshot.entries.length > 128) throw new DomainError('SHARE_TOO_LARGE');
  const budget = calculateBudget(snapshot);
  const trusted = new Map(catalog().map(item => [item.id, item]));
  const result: PublicTrip = {
    destinationId: snapshot.requirements.destinationId, days: snapshot.requirements.days, people: snapshot.requirements.people,
    budget: { knownMinor: budget.knownMinor, limitMinor: snapshot.requirements.budgetMinor,
      unknownCount: budget.unknownEntryIds.length, exclusionsCount: snapshot.exclusions.length },
    entries: snapshot.entries.map(entry => {
      const item = trusted.get(entry.catalogId);
      // Historical/unrecognized catalog prose cannot smuggle user/contact data.
      // Do not cite current sources as proof of a different archived price.
      const verified = !!item && isDeepStrictEqual(item, entry.item);
      return { day: entry.day, slot: entry.slot, endDay: entry.endDay, rooms: entry.rooms,
        title: verified ? item!.title : '封存行程項目（來源待重新確認）', kind: entry.item.kind,
        demo: entry.item.price.basis === 'demo' || entry.item.sources.some(source => source.kind === 'demo'),
        sourceVerified: verified,
        price: { unit: entry.item.price.unit, unitMinor: entry.item.price.unitMinor, basis: entry.item.price.basis },
        sources: verified ? item!.sources.map(source => ({ url: source.url, label: source.label, checkedAt: source.checkedAt, kind: source.kind })) : [],
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw new DomainError('SHARE_TOO_LARGE');
  return result;
}

async function owned(client: PoolClient, owner: string, trip: string) {
  if (![owner, trip].every(id => z.uuid().safeParse(id).success)) throw new DomainError('NOT_FOUND');
  if (!(await client.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR SHARE', [owner])).rowCount) throw new DomainError('NOT_FOUND');
  if (!(await client.query('SELECT id FROM trips WHERE id=$1 AND owner_id=$2 FOR UPDATE', [trip, owner])).rowCount) throw new DomainError('NOT_FOUND');
  const result = await client.query<{ current_version: number; expires_at: Date; snapshot: unknown }>(`
    SELECT t.current_version,LEAST(t.expires_at,s.expires_at) AS expires_at,v.snapshot
    FROM trips t JOIN sessions s ON s.id=t.owner_id
    JOIN trip_versions v ON v.trip_id=t.id AND v.version=t.current_version
    WHERE t.id=$1 AND t.owner_id=$2 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`, [trip, owner]);
  if (!result.rowCount) throw new DomainError('NOT_FOUND');
  return result.rows[0];
}

export async function getSharePreview(owner: string, trip: string, baseVersion: number) {
  if (!version.safeParse(baseVersion).success) throw new DomainError('INVALID_SHARE');
  return transaction(database(), async client => {
    const row = await owned(client, owner, trip);
    if (row.current_version !== baseVersion) throw new DomainError('STALE_VERSION');
    const snapshot = parseSnapshot(row.snapshot);
    const preview = previewShare({ id: trip, version: baseVersion, snapshot, budget: calculateBudget(snapshot) });
    return { preview, previewHash: hashPreview(preview), version: baseVersion, expiresAt: row.expires_at.toISOString() };
  });
}

export async function createShare(owner: string, trip: string, baseVersion: number, previewHash: string) {
  if (!version.safeParse(baseVersion).success || !/^[a-f0-9]{64}$/.test(previewHash)) throw new DomainError('INVALID_SHARE');
  return transaction(database(), async client => {
    const row = await owned(client, owner, trip);
    if (row.current_version !== baseVersion) throw new DomainError('STALE_VERSION');
    const snapshot = parseSnapshot(row.snapshot);
    const preview = previewShare({ id: trip, version: baseVersion, snapshot, budget: calculateBudget(snapshot) });
    if (hashPreview(preview) !== previewHash) throw new DomainError('SHARE_PREVIEW_CHANGED');
    // Bound anonymous storage, including revoked rows. Never silently delete history.
    if ((await client.query('SELECT count(*)::int AS n FROM trip_shares WHERE trip_id=$1', [trip])).rows[0].n >= 20) throw new DomainError('SHARE_LIMIT');
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    await client.query(`INSERT INTO trip_shares(id,trip_id,version,token_hash,snapshot,expires_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [id, trip, baseVersion, hash(token), JSON.stringify(preview), row.expires_at]);
    return { id, token, version: baseVersion, expiresAt: row.expires_at.toISOString() };
  });
}

export async function readShare(token: string): Promise<PublicTrip | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await database().query<{ snapshot: PublicTrip }>(`SELECT sh.snapshot FROM trip_shares sh
    JOIN trips t ON t.id=sh.trip_id JOIN sessions s ON s.id=t.owner_id
    WHERE sh.token_hash=$1 AND sh.revoked_at IS NULL AND sh.expires_at>clock_timestamp()
      AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`, [hash(token)]);
  return result.rows[0]?.snapshot ?? null;
}

export async function listShares(owner: string, trip: string) {
  return transaction(database(), async client => {
    await owned(client, owner, trip);
    return (await client.query<{ id: string; version: number; expiresAt: Date; revoked: boolean }>(`
      SELECT id,version,expires_at AS "expiresAt",revoked_at IS NOT NULL AS revoked
      FROM trip_shares WHERE trip_id=$1 ORDER BY created_at DESC,id`, [trip])).rows
      .map(row => ({ ...row, expiresAt: row.expiresAt.toISOString() }));
  });
}
export async function revokeShare(owner: string, trip: string, share: string): Promise<void> {
  if (!z.uuid().safeParse(share).success) throw new DomainError('NOT_FOUND');
  await transaction(database(), async client => {
    await owned(client, owner, trip);
    if (!(await client.query('UPDATE trip_shares SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND trip_id=$2', [share, trip])).rowCount) throw new DomainError('NOT_FOUND');
  });
}
