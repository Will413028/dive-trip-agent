import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, type Pool } from 'pg';
import { compareCloudflareCarryForward, readCloudflareCarryForward } from '../../evals/cloudflare-carry-forward';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { fixture } from '../support/cloudflare-carry-fixture';


test('consistent projections retain historical unknown and never grant dispatch or quality', () => {
  const f = fixture(); const before = structuredClone(f);
  expect(compareCloudflareCarryForward(f.report, f.baseline, f.snapshot)).toEqual({
    historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 1, invocations: 8, modelCalls: 11, chargedMicros: 188267, observedTokens: 46665,
    totalTokens: null, remainingInvocationCeiling: 92, remainingReferenceMicros: 2811733,
  });
  expect(f).toEqual(before);
});

function offlinePool() {
  return { options: { connectionString: undefined as string | undefined, host: '127.0.0.1', port: 1,
    database: 'dive_trip_test', user: 'postgres', ssl: false,
    password: 'offline-placeholder-not-a-credential',
    connectionTimeoutMillis: 1000, statement_timeout: 1000 }, connect: vi.fn(async () => { throw new Error('NO_DB_EXPECTED'); }) };
}

test.each(['remote', 'database', 'password', 'query', 'unbounded-connect', 'unbounded-query', 'credential-fallback', 'url-overrides-password'])(
  'rejects unsafe pool before reading evidence or connecting: %s', async mode => {
    const pool = offlinePool();
    if (mode === 'remote') pool.options.host = 'remote.invalid';
    if (mode === 'database') pool.options.database = 'production';
    if (mode === 'password') pool.options.connectionString = 'postgresql://postgres:synthetic@127.0.0.1:1/dive_trip_test';
    if (mode === 'query') pool.options.connectionString = 'postgresql://postgres@127.0.0.1:1/dive_trip_test?options=synthetic';
    if (mode === 'unbounded-connect') pool.options.connectionTimeoutMillis = 0;
    if (mode === 'unbounded-query') pool.options.statement_timeout = 0;
    if (mode === 'credential-fallback') pool.options.password = '';
    if (mode === 'url-overrides-password') pool.options.connectionString = 'postgresql://postgres@127.0.0.1:1/dive_trip_test';
    await expect(readCloudflareCarryForward(pool as unknown as Pool, pool as unknown as Pool)).rejects.toThrow('CLOUDFLARE_CARRY_FORWARD_INVALID');
    expect(pool.connect).not.toHaveBeenCalled();
  });

test('explicit fields preserve the synthetic password in the actual pg Client without connecting', () => {
  const client = new Client(offlinePool().options);
  // Boolean-only assertion prevents accidental credential output on regression.
  expect(client.password === 'offline-placeholder-not-a-credential').toBe(true);
  expect(client.host === '127.0.0.1' && client.database === 'dive_trip_test' && client.user === 'postgres').toBe(true);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {Client} from 'pg'; const c=new Client(${JSON.stringify(offlinePool().options)}); process.stdout.write(String(c.password === 'offline-placeholder-not-a-credential'));`],
  { encoding: 'utf8', env: { NODE_ENV: 'test', PGPASSWORD: 'synthetic-environment-password', PGPASSFILE: '/nonexistent-synthetic-passfile' }, timeout: 5000 });
  expect(result).toBe('true');
});

test.each(['missing-claim', 'claim-link', 'report-link', 'report-directory', 'oversized', 'wrong-hash', 'lock'])(
  'fixed file boundary rejects %s without DB or report writes', async mode => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cf-carry-')));
    const dir = join(root, '.artifacts'); const pool = offlinePool();
    await mkdir(dir);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const claim = join(dir, 'cloudflare-evaluation-1.claim');
      const report = join(dir, 'cloudflare-evaluation-1.json');
      if (mode === 'claim-link') await symlink(report, claim);
      else if (mode !== 'missing-claim') await writeFile(claim, '{}');
      if (mode === 'report-link') await symlink(claim, report);
      else if (mode === 'report-directory') await mkdir(report);
      else await writeFile(report, mode === 'oversized' ? 'x'.repeat(2_000_001) : '{}');
      if (mode === 'lock') await writeFile(join(dir, 'live-evaluation.lock'), '{}');
      await expect(readCloudflareCarryForward(pool as unknown as Pool, pool as unknown as Pool)).rejects.toThrow('CLOUDFLARE_CARRY_FORWARD_INVALID');
      expect(pool.connect).not.toHaveBeenCalled();
    } finally { cwd.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
test.each(['extra-call', 'missing-run', 'duplicate-run', 'extra-receipt', 'event-change', 'foreign-event', 'version',
  'new-unknown', 'cleared-unknown', 'lower-reserve', 'wrong-receipt', 'wrong-account', 'wrong-model', 'missing-usage',
  'old-hash', 'prior-cost', 'quality', 'total-known', 'status', 'resume', 'usage-change', 'extra-field', 'trip', 'owner'])(
  'rejects changed evidence: %s', mode => {
    const f = fixture();
    switch (mode) {
      case 'extra-call': f.snapshot.counts.calls++; break;
      case 'missing-run': f.snapshot.runs.pop(); break;
      case 'duplicate-run': f.snapshot.runs[1] = f.snapshot.runs[0]; break;
      case 'extra-receipt': f.snapshot.counts.reservations++; break;
      case 'event-change': f.snapshot.events[0].event.type = 'RUN_ERROR'; break;
      case 'foreign-event': f.snapshot.events[0].run_id = f.snapshot.runs[1].id; break;
      case 'version': f.snapshot.runs[0].current_version = 2; break;
      case 'new-unknown': f.snapshot.usage[0].invocations[0].actual_cost_micros = null; break;
      case 'cleared-unknown': f.snapshot.usage[1].invocations[0].actual_cost_micros = '612'; break;
      case 'lower-reserve': f.snapshot.usage[1].invocations[0].charged_cost_micros = '612'; break;
      case 'wrong-receipt': f.snapshot.usage[1].invocations[0].reservation_id = f.snapshot.usage[0].invocations[0].reservation_id; break;
      case 'wrong-account': f.snapshot.usage[1].binding.accountId = 'a'.repeat(32); break;
      case 'wrong-model': f.snapshot.usage[1].binding.model = 'wrong' as typeof CLOUDFLARE_MODEL; break;
      case 'missing-usage': f.snapshot.usage[1].calls.length = 0; break;
      case 'old-hash': f.baseline.history[0].sha256 = 'f'.repeat(64); break;
      case 'prior-cost': f.baseline.chargedMicros++; break;
      case 'quality': f.report.evaluationGatePassed = true; break;
      case 'total-known': Object.assign(f.report, { totalTokens: 10262 }); break;
      case 'status': f.snapshot.runs[1].status = 'succeeded'; break;
      case 'resume': f.snapshot.usage[1].invocations[0].kind = 'resume'; break;
      case 'usage-change': f.snapshot.usage[1].calls[0].usage.totalTokens++; break;
      case 'extra-field': Object.assign(f.snapshot, { dispatchAuthorized: true }); break;
      case 'trip': f.snapshot.runs[0].trip_id = f.snapshot.runs[1].trip_id; break;
      case 'owner': f.snapshot.runs[0].owner_id = f.snapshot.runs[1].owner_id; break;
    }
    expect(() => compareCloudflareCarryForward(f.report, f.baseline, f.snapshot)).toThrow('CLOUDFLARE_CARRY_FORWARD_INVALID');
  });
