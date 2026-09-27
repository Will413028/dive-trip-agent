import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '../domain/errors.ts';
import { database, transaction } from './db.ts';
import { lockQuotaGlobal } from './quota.ts';

// Direct SQL is intentional: SDK deleteSession uses separate ORM transactions.
// Pin to ADK 2.1 schema v1 so product and ADK deletion commit or roll back together.
async function erase(client: PoolClient, owner: string, trip: string) {
  const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
  if (!/^[a-z][a-z0-9_]{0,55}$/.test(schema)) throw new Error('INVALID_RETENTION_SCHEMA');
  const adk = `${schema}_adk`;
  const runs = (await client.query<{ id: string }>('SELECT id FROM agent_runs WHERE trip_id=$1 ORDER BY id', [trip])).rows;
  if ((await client.query(`SELECT id FROM agent_runs WHERE trip_id=$1
    AND status='running' AND lease_expires_at>clock_timestamp()`, [trip])).rowCount) throw new DomainError('RUN_ACTIVE');
  // Never wait on a worker while holding product locks: its callbacks need them.
  for (const run of runs) {
    if (!(await client.query('SELECT pg_try_advisory_xact_lock(724916,hashtext($1)) AS ok', [`${adk}:${run.id}`])).rows[0].ok) {
      throw new DomainError('RUN_ACTIVE');
    }
  }
  if (!(await client.query('SELECT pg_try_advisory_xact_lock(724915,hashtext($1)) AS ok', [adk])).rows[0].ok) {
    throw new DomainError('RUN_ACTIVE');
  }
  const exists = (await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [adk])).rows[0].present;
  if (exists) {
    const version = await client.query(`SELECT value FROM "${adk}".adk_internal_metadata WHERE key='schema_version'`);
    if (version.rows[0]?.value !== '1') throw new Error('UNSUPPORTED_ADK_SCHEMA');
    const ids = runs.map(run => run.id);
    await client.query(`DELETE FROM "${adk}".events WHERE app_name=$1 AND user_id=$2 AND session_id=ANY($3::text[])`, ['dive_trip_fixture', owner, ids]);
    await client.query(`DELETE FROM "${adk}".sessions WHERE app_name=$1 AND user_id=$2 AND id=ANY($3::text[])`, ['dive_trip_fixture', owner, ids]);
    // Shared app/user state is empty in this product; preserve other live sessions.
    await client.query(`DELETE FROM "${adk}".user_states u WHERE app_name=$1 AND user_id=$2
      AND NOT EXISTS(SELECT 1 FROM "${adk}".sessions s WHERE s.app_name=u.app_name AND s.user_id=u.user_id)`, ['dive_trip_fixture', owner]);
  }
  await client.query('DELETE FROM model_calls WHERE run_id IN (SELECT id FROM agent_runs WHERE trip_id=$1)', [trip]);
  await client.query('DELETE FROM agent_invocations WHERE run_id IN (SELECT id FROM agent_runs WHERE trip_id=$1)', [trip]);
  // Quota receipts deliberately survive. Deleting content must never reset limits.
  await client.query('DELETE FROM trips WHERE id=$1', [trip]);
}

export async function deleteTrip(owner: string, trip: string): Promise<void> {
  if (![owner, trip].every(id => z.uuid().safeParse(id).success)) throw new DomainError('NOT_FOUND');
  await transaction(database(), async client => {
    await lockQuotaGlobal(client);
    // Mutations lock owner FOR SHARE before claiming receipts. Exclusive owner
    // lock drains those transactions before trip -> receipt cascade deletion.
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [owner]);
    await client.query('SELECT id FROM trips WHERE id=$1 AND owner_id=$2 FOR UPDATE', [trip, owner]);
    if (!(await client.query(`SELECT t.id FROM trips t JOIN sessions s ON s.id=t.owner_id
      WHERE t.id=$1 AND t.owner_id=$2 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`, [trip, owner])).rowCount) {
      throw new DomainError('NOT_FOUND');
    }
    await erase(client, owner, trip);
  });
}

/** Bounded product-content sweep; not yet the quota compaction/scheduler job.
 * DB clock is authoritative. Never accepts a future caller-controlled cutoff. */
export async function expireTrips(): Promise<{ deletedTrips: number; busyTrips: number }> {
  const candidates = (await database().query<{ id: string; owner_id: string }>(`SELECT t.id,t.owner_id
    FROM trips t JOIN sessions s ON s.id=t.owner_id
    WHERE LEAST(t.expires_at,s.expires_at)<=clock_timestamp() ORDER BY t.id LIMIT 100`)).rows;
  let deletedTrips = 0, busyTrips = 0;
  for (const trip of candidates) {
    try {
      deletedTrips += await transaction(database(), async client => {
        await lockQuotaGlobal(client);
        await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [trip.owner_id]);
        await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
        if (!(await client.query(`SELECT t.id FROM trips t JOIN sessions s ON s.id=t.owner_id
          WHERE t.id=$1 AND LEAST(t.expires_at,s.expires_at)<=clock_timestamp()`, [trip.id])).rowCount) return 0;
        await erase(client, trip.owner_id, trip.id);
        return 1;
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'RUN_ACTIVE') busyTrips++;
      else throw error;
    }
  }
  return { deletedTrips, busyTrips };
}

/** Delete only empty expired owners; never cascade around the worker fences. */
export async function expireSessions(): Promise<number> {
  return transaction(database(), async client => {
    await lockQuotaGlobal(client);
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
    if (!/^[a-z][a-z0-9_]{0,55}$/.test(schema)) throw new Error('INVALID_RETENTION_SCHEMA');
    const adk = `${schema}_adk`;
    if (!(await client.query('SELECT pg_try_advisory_xact_lock(724915,hashtext($1)) AS ok', [adk])).rows[0].ok) return 0;
    const exists = (await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [adk])).rows[0].present;
    if (exists && (await client.query(`SELECT value FROM "${adk}".adk_internal_metadata WHERE key='schema_version'`)).rows[0]?.value !== '1') {
      throw new Error('UNSUPPORTED_ADK_SCHEMA');
    }
    // Exclude protected orphans BEFORE LIMIT so they cannot starve later owners.
    const protectedOwners = exists ? `AND NOT EXISTS(SELECT 1 FROM "${adk}".sessions a WHERE a.user_id=s.id::text)
      AND NOT EXISTS(SELECT 1 FROM "${adk}".events a WHERE a.user_id=s.id::text)` : '';
    const owners = (await client.query<{ id: string }>(`SELECT id FROM sessions s
      WHERE expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM trips WHERE owner_id=s.id)
      ${protectedOwners} ORDER BY id LIMIT 100 FOR UPDATE`)).rows;
    let deleted = 0;
    for (const owner of owners) {
      if (exists) {
        // Unexpected orphan sessions are retained for investigation, not erased blindly.
        if ((await client.query(`SELECT 1 FROM "${adk}".sessions WHERE user_id=$1 LIMIT 1`, [owner.id])).rowCount) continue;
        if ((await client.query(`SELECT 1 FROM "${adk}".events WHERE user_id=$1 LIMIT 1`, [owner.id])).rowCount) continue;
        await client.query(`DELETE FROM "${adk}".user_states WHERE app_name='dive_trip_fixture' AND user_id=$1`, [owner.id]);
      }
      deleted += (await client.query(`DELETE FROM sessions s WHERE id=$1 AND expires_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM trips WHERE owner_id=s.id)`, [owner.id])).rowCount ?? 0;
    }
    return deleted;
  });
}

// Preserve current-day/minute counters, live owners, and invocations awaiting cleanup.
const compactable = `q.reserved_at<=clock_timestamp()-interval '30 days'
  AND q.expires_at<=clock_timestamp()
  AND q.day<(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date
  AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=q.owner_id AND s.expires_at>clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM agent_invocations i WHERE i.reservation_id=q.id)`;

export async function compactQuota(): Promise<number> {
  return transaction(database(), async client => {
    // Same gate as admission and late settlement: no lost charges or double count.
    await lockQuotaGlobal(client);
    const result = await client.query(`WITH removed AS (
      DELETE FROM quota_reservations WHERE id IN (
        SELECT q.id FROM quota_reservations q WHERE ${compactable} ORDER BY q.reserved_at,q.id LIMIT 1000
      ) RETURNING day,charged_cost_micros,actual_cost_micros
    ), totals AS (
      INSERT INTO quota_daily_totals(day,reservations,charged_cost_micros,unknown_usage)
      SELECT day,count(*),sum(charged_cost_micros),count(*) FILTER(WHERE actual_cost_micros IS NULL)
      FROM removed GROUP BY day
      ON CONFLICT(day) DO UPDATE SET
        reservations=quota_daily_totals.reservations+EXCLUDED.reservations,
        charged_cost_micros=quota_daily_totals.charged_cost_micros+EXCLUDED.charged_cost_micros,
        unknown_usage=quota_daily_totals.unknown_usage+EXCLUDED.unknown_usage
      RETURNING day
    ) SELECT count(*)::int AS removed FROM removed`);
    // Empty lock buckets carry identifiers too; no usage is stored in these rows.
    await client.query(`DELETE FROM quota_session_days b WHERE NOT EXISTS(
      SELECT 1 FROM quota_reservations q WHERE q.owner_id=b.owner_id AND q.day=b.day)`);
    await client.query(`DELETE FROM quota_ips b WHERE NOT EXISTS(SELECT 1 FROM quota_reservations q WHERE q.ip_key=b.ip_key)`);
    await client.query(`DELETE FROM quota_days b WHERE NOT EXISTS(SELECT 1 FROM quota_reservations q WHERE q.day=b.day)`);
    await client.query(`DELETE FROM quota_daily_totals WHERE day<(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date-90`);
    return result.rows[0].removed;
  });
}

export async function retentionPreview() {
  return (await database().query(`SELECT
    (SELECT count(*)::int FROM trips t JOIN sessions s ON s.id=t.owner_id
      WHERE LEAST(t.expires_at,s.expires_at)<=clock_timestamp()) AS "expiredTrips",
    (SELECT count(*)::int FROM sessions WHERE expires_at<=clock_timestamp()) AS "expiredSessions",
    (SELECT count(*)::int FROM quota_reservations q WHERE ${compactable}) AS "compactableReceipts"`)).rows[0] as {
      expiredTrips: number; expiredSessions: number; compactableReceipts: number;
    };
}

export async function expireData() {
  const trips = await expireTrips();
  const deletedSessions = await expireSessions();
  const compactedReceipts = await compactQuota();
  return { ...trips, deletedSessions, compactedReceipts };
}
