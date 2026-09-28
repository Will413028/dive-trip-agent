// Retired SDK storage fixture only. No model, credential loader, or network transport.
import { DatabaseSessionService, createEvent } from '@google/adk';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { z } from 'zod';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = z.strictObject({
  port: z.number().int().min(1).max(65535),
  schema: z.string().regex(/^python_test_[a-f0-9]{32}$/),
  sessions: z.array(z.strictObject({ owner: z.uuid(), run: z.uuid() })).min(1).max(3),
}).parse(JSON.parse(raw));
const url = `postgresql://postgres@127.0.0.1:${input.port}/postgres`;
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const admin = await pool.connect();
try {
  const target = await admin.query('SELECT current_database() AS name,to_regnamespace($1) AS namespace', [input.schema]);
  if (target.rows[0].name !== 'postgres' || !target.rows[0].namespace) throw new Error('ISOLATED_SCHEMA_REQUIRED');
  const schema = `${input.schema}_adk`;
  const service = new DatabaseSessionService({ driver: PostgreSqlDriver, clientUrl: url, schema,
    debug: false, pool: { min: 0, max: 2 }, driverOptions: { connectionTimeoutMillis: 3000, statement_timeout: 5000 } });
  await withAdkSchemaLock(admin, async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await service.init();
  });
  for (const item of input.sessions) {
    const session = await service.createSession({ appName: 'dive_trip_fixture', userId: item.owner,
      sessionId: item.run, state: { 'user:synthetic': true } });
    await service.appendEvent({ session, event: createEvent({ author: 'user', invocationId: 'synthetic-history',
      content: { role: 'user', parts: [{ text: 'synthetic legacy content' }] } }) });
  }
  process.stdout.write('LEGACY_FIXTURE_READY\n');
} finally { admin.release(); await pool.end(); }
// This retired SDK has no public close method; the bounded fixture process owns its pools.
process.exit(0);
