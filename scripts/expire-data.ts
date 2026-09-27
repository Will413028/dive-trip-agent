import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { makePool, withDatabasePool } from '../src/server/db.ts';
import { expireData, retentionPreview } from '../src/server/retention.ts';
import { testDatabaseUrl } from '../tests/support/database.ts';

export function retentionArgs(args: string[]) {
  const schema = args.find(arg => arg.startsWith('--schema='))?.slice('--schema='.length);
  if (!['workbench_demo', 'workbench_live'].includes(schema ?? '')
    || new Set(args).size !== args.length
    || args.some(arg => !['--apply', '--watch', `--schema=${schema}`].includes(arg))
    || (args.includes('--watch') && !args.includes('--apply'))) throw new Error('INVALID_RETENTION_ARGUMENTS');
  if (schema === 'workbench_live' && args.includes('--apply')) throw new Error('WORKBENCH_LIVE_READ_ONLY');
  return { schema: schema!, apply: args.includes('--apply'), watch: args.includes('--watch') };
}

export async function runRetention(args: string[]) {
  const options = retentionArgs(args);
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  // Dedicated loopback Compose DB only. No env files, credentials or migrations.
  const pool = makePool(testDatabaseUrl(), options.schema);
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
  try {
    const identity = (await pool.query('SELECT current_database() AS db,current_schema() AS schema')).rows[0];
    if (identity.db !== 'dive_trip_test' || identity.schema !== options.schema) throw new Error('INVALID_RETENTION_TARGET');
    if (!(await pool.query("SELECT id FROM schema_migrations WHERE id='009-retention'")).rowCount) throw new Error('RETENTION_MIGRATION_REQUIRED');
    do {
      if (stop.signal.aborted) break;
      const result = options.apply ? await withDatabasePool(pool, expireData) : await withDatabasePool(pool, retentionPreview);
      const remaining = options.apply ? await withDatabasePool(pool, retentionPreview) : undefined;
      console.log(JSON.stringify({ schema: options.schema, mode: options.apply ? 'apply' : 'dry-run', ...result,
        ...(remaining ? { remaining } : {}) }));
      if (!options.watch) break;
      try { await delay(3_600_000, undefined, { signal: stop.signal }); }
      catch { if (!stop.signal.aborted) throw new Error('RETENTION_TIMER_FAILED'); }
    } while (!stop.signal.aborted);
  } finally {
    process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRetention(process.argv.slice(2)).catch(() => { console.error('RETENTION_FAILED'); process.exitCode = 1; });
}
