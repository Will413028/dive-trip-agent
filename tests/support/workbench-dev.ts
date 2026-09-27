import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makePool } from '../../src/server/db.ts';
import { migrate } from '../../src/server/migrate.ts';
import { testDatabaseUrl } from './database.ts';
import { offlineNextEnvironment } from './next-environment.ts';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock.ts';
import { parseWorkbenchOptions } from './workbench-options.ts';

const options = parseWorkbenchOptions(process.argv.slice(2));
const { e2e, production, liveProvider } = options;
// This cutover only admits the independent offline demo. Stop before database
// migration, credential loading or ingress creation; legacy live is history.
if (liveProvider !== undefined) {
  console.error('WORKBENCH_LIVE_READ_ONLY'); process.exit(1);
}
const publicPort = e2e ? 4319 : options.port ?? 4318;
const schema = e2e ? `e2e_${randomUUID().replaceAll('-', '')}` : 'workbench_demo';
const url = testDatabaseUrl();
const admin = makePool(url);
const pool = makePool(url, schema);
let child: ChildProcess | undefined;
let stopping = false;
let cleaned = false;
let schemaCreated = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await pool.end();
  try { if (e2e && schemaCreated) {
    const client = await admin.connect();
    try { await withAdkSchemaLock(client, async () => {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}_adk" CASCADE`);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }); } finally { client.release(); }
  } }
  finally { await admin.end(); }
}
function stop() {
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const env = await offlineNextEnvironment();
  if ((await admin.query('SELECT current_database() AS name')).rows[0]?.name !== 'dive_trip_test') throw new Error('DEDICATED_TEST_DATABASE_REQUIRED');
  if (!stopping) {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`); schemaCreated = true;
    await migrate(pool);
  }
  if (stopping) await cleanup();
  else {
    const databaseUrl = new URL(url); databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    const args = [production ? 'start' : 'dev', '-H', '127.0.0.1', '-p', String(publicPort)];
    if (!production) args.push('--webpack');
    child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('next/dist/bin/next')), ...args], {
      env: { ...env, DATABASE_URL: databaseUrl.toString(), APP_ORIGIN: `http://127.0.0.1:${publicPort}` }, stdio: 'inherit',
    });
    child.once('error', () => { process.exitCode = 1; void cleanup(); });
    child.once('exit', code => { process.exitCode = stopping ? 0 : code ?? 1; void cleanup(); });
  }
} catch {
  console.error('WORKBENCH_START_FAILED'); process.exitCode = 1;
  stop(); await cleanup();
}
