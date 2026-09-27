import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { z } from 'zod';

/** The HTTP response is a stream, not a worker-completion promise. After a
 * cancelled collector, wait for terminal run + settlement before exporting.
 * Never dispatch/retry/reconcile. A timeout is evidence for retaining the schema.
 * One five-second deadline covers acquisition and polling; each query is <=1s. */
export async function waitForCloudflareCampaignDrain(pool: Pool, tripId: string): Promise<boolean> {
  z.uuid().parse(tripId);
  const deadline = Date.now() + 5000;
  let client: PoolClient | undefined;
  try {
    client = await new Promise<PoolClient>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('EVAL_DRAIN_TIMEOUT')); }, 5000);
      Promise.resolve().then(() => pool.connect()).then(value => {
        clearTimeout(timer);
        if (expired) value.release(true); else resolve(value);
      }, () => { clearTimeout(timer); reject(new Error('EVAL_DRAIN_UNAVAILABLE')); });
    });
    do {
      if (Date.now() >= deadline) return false;
      const config: QueryConfig & { query_timeout: number } = {
        text: `SELECT current_schema() AS schema,
        NOT ((SELECT count(*) FROM agent_runs WHERE trip_id=$1)=1 AND EXISTS (
          SELECT 1 FROM agent_runs r WHERE r.trip_id=$1
          AND r.status IN ('succeeded','failed','awaiting_confirmation')
          AND (SELECT e.event->>'type' FROM agent_run_events e WHERE e.run_id=r.id
            ORDER BY e.sequence DESC LIMIT 1)=CASE WHEN r.status='failed' THEN 'RUN_ERROR' ELSE 'RUN_FINISHED' END
          AND EXISTS (SELECT 1 FROM agent_invocations i WHERE i.run_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM agent_invocations i
            LEFT JOIN quota_reservations q ON q.id=i.reservation_id
            WHERE i.run_id=r.id AND (i.status<>'settled' OR q.id IS NULL
              OR q.status<>'settled' OR q.logical_run_id IS DISTINCT FROM r.id)))) AS busy`,
        values: [tripId], query_timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      };
      const rows = (await client.query(config)).rows;
      if (Date.now() >= deadline) return false;
      if (rows.length !== 1 || typeof rows[0].schema !== 'string' || rows[0].schema.length !== 37
        || !/^test_[a-f0-9]{32}$/.test(rows[0].schema) || typeof rows[0].busy !== 'boolean') return false;
      if (!rows[0].busy) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(200, remaining));
    } while (Date.now() < deadline);
    return false;
  } catch { return false; }
  finally { client?.release(true); }
}
