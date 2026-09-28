import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { transaction } from './db.ts';

type Migration = { id: string; sql: string };

export async function loadMigrations(): Promise<Migration[]> {
  return Promise.all(['001-core', '002-proposals', '003-proposal-catalog', '004-agent-runs', '005-quota', '006-agent-admission', '007-model-transition', '008-sharing', '009-retention', '010-openrouter-provider', '011-cloudflare-provider', '012-grounded-answers', '013-zero-model-continuation'].map(async id => ({
    id, sql: await readFile(new URL(`../../migrations/${id}.sql`, import.meta.url), 'utf8'),
  })));
}

export async function migrate(pool: Pool, supplied?: readonly Migration[]): Promise<void> {
  const migrations = supplied ?? await loadMigrations();
  if (new Set(migrations.map(m => m.id)).size !== migrations.length) throw new Error('DUPLICATE_MIGRATION');
  await transaction(pool, async client => {
    // Transaction-scoped lock serializes startup, including table creation.
    await client.query('SELECT pg_advisory_xact_lock(724913, hashtext(current_schema()))');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map(row => [row.id, row.checksum]));
    if (result.rows.some(row => !migrations.some(m => m.id === row.id))) throw new Error('UNKNOWN_MIGRATION');
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      if (applied.has(migration.id)) {
        if (applied.get(migration.id) !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [migration.id, checksum]);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('LEGACY_MIGRATION_RETIRED: use pnpm db:migrate');
}
