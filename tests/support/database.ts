import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { makePool, withDatabasePool } from '../../src/server/db.ts';
import { migrate } from '../../src/server/migrate.ts';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock.ts';

export function testDatabaseUrl(): string {
  // No environment URL override: tests must never connect to another project.
  const output = execFileSync('docker', [
    'compose', '--env-file', '/dev/null', '-f', 'compose.test.yml',
    'port', 'dive-trip-test-db', '5432',
  ], { encoding: 'utf8' }).trim();
  const port = /^127\.0\.0\.1:(\d+)$/.exec(output)?.[1];
  if (!port) throw new Error('DEDICATED_TEST_DATABASE_REQUIRED');
  return `postgresql://postgres@127.0.0.1:${port}/dive_trip_test`;
}

export async function withDatabase(work: () => Promise<void>, options: { retainOnFailure?: boolean } = {}): Promise<void> {
  const url = testDatabaseUrl();
  const admin = makePool(url);
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pool = makePool(url, schema);
  let created = false, failed = false;
  try {
    const result = await admin.query<{ name: string }>('SELECT current_database() AS name');
    if (result.rows[0]?.name !== 'dive_trip_test') throw new Error('DEDICATED_TEST_DATABASE_REQUIRED');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await migrate(pool);
    await withDatabasePool(pool, work);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await pool.end();
    try {
      if (created && failed && options.retainOnFailure) {
        // Isolated evaluation forensics only; never print the DB URL or credentials.
        console.error('EVALUATION_DB_RETAINED', schema);
      } else if (created) {
        const client = await admin.connect();
        try { await withAdkSchemaLock(client, async () => {
          await client.query(`DROP SCHEMA IF EXISTS "${schema}_adk" CASCADE`);
          await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        }); } finally { client.release(); }
      }
    } finally { await admin.end(); }
  }
}
