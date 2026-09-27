import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { readCloudflareCampaignBaseline, captureCloudflareCampaignBaseline } from '../../evals/cloudflare-campaign-history';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
import { validateCloudflareSmokeAudit } from '../support/cloudflare-smoke-audit';

const names = ['cloudflare-gemma26b-smoke.json', 'cloudflare-product-smoke.json',
  'cloudflare-product-smoke-2.json', 'cloudflare-product-smoke-3.json'];
const accountId = 'a'.repeat(32);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixtures() {
  const invocations: Record<string, unknown>[] = [], calls: Record<string, unknown>[] = [];
  const counts = [[[4223, 291], [4328, 29]], [[4223, 543], [4327, 29], [4375, 106]], [[4250, 367], [4355, 29], [4512, 27]]];
  const audits = counts.map((tokens, index) => {
    const run = id(10 + index), trip = id(20 + index), firstInvocation = id(30 + index * 2), secondInvocation = id(31 + index * 2);
    const runCalls = tokens.map(([prompt, output], n) => ({ invocation_id: n < 2 ? firstInvocation : secondInvocation,
      run_id: run, call_id: `call-${index}-${n}`, status: 'completed', usage: { promptTokens: prompt, outputTokens: output, totalTokens: prompt + output },
      provider_evidence: { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } }));
    const runInvocations = Array.from({ length: index === 0 ? 1 : 2 }, (_, n) => {
      const invocationId = n === 0 ? firstInvocation : secondInvocation;
      const cost = runCalls.filter(c => c.invocation_id === invocationId).reduce((sum, c) => sum + Math.ceil((c.usage.promptTokens + c.usage.outputTokens * 3) / 10), 0);
      return { id: invocationId, run_id: run, trip_id: trip, reservation_id: id(40 + index * 2 + n),
        provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: accountId, kind: n === 0 ? 'start' : 'resume', status: 'settled',
        reservation_status: 'settled', logical_run_id: run, actual_cost_micros: String(cost), charged_cost_micros: String(cost),
        run_status: index === 0 ? 'awaiting_confirmation' : 'succeeded', decision: index === 0 ? null : true,
        current_version: index === 0 ? 1 : 2, reservation_owner_id: id(1), trip_owner_id: id(1) };
    });
    invocations.push(...runInvocations); calls.push(...runCalls);
    return validateCloudflareSmokeAudit({ invocations: runInvocations, calls: runCalls }, accountId);
  });
  const reports: Record<string, unknown>[] = [{ model: CLOUDFLARE_MODEL, startedAt: '2026-09-26T00:00:00.000Z',
    requestStartedAt: '2026-09-26T00:00:00.000Z', calls: 1, status: 'tool-call-passed',
    usage: { prompt_tokens: 160, completion_tokens: 229, total_tokens: 389 }, httpStatus: 200, providerSuccess: true,
    returnedModel: `${CLOUDFLARE_MODEL}-external`, errorCodes: [], finishReason: 'tool_calls', toolCalls: [{ expectedName: true, expectedArguments: true }] }];
  const strings = [JSON.stringify(reports[0])];
  audits.forEach((audit, index) => {
    const prior = index === 1 ? { modelCalls: 3, totalTokens: 9260 } : { modelCalls: 6, totalTokens: 22863 };
    const report = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, startedAt: '2026-09-26T00:00:00.000Z',
      status: index === 0 ? 'stopped' : 'passed', maxModelCalls: 7, modelQualityAccepted: false, privateUsageComplete: true,
      priorDirectSmoke: { modelCalls: 1, totalTokens: 389 }, audit,
      cumulativeModelCallsIncludingDirectSmoke: [3, 6, 9][index], cumulativeTokensIncludingDirectSmoke: [9260, 22863, 36403][index],
      phase: index === 0 ? 'proposal' : 'complete', tripId: id(20 + index), agentPosts: index === 0 ? 1 : 2, blocked: index === 0,
      ...(index === 0 ? {} : { attempt: index + 1, priorCumulative: prior,
        priorProductSmoke: { reportPath: `.artifacts/${names[1]}`, sha256: hash(strings[1]), modelCalls: 2, totalTokens: 8871 } }),
      ...(index < 2 ? {} : { priorSecondProductSmoke: { reportPath: `.artifacts/${names[2]}`, sha256: hash(strings[2]), modelCalls: 3, totalTokens: 13603 } }),
    };
    reports.push(report); strings.push(JSON.stringify(report));
  });
  return { invocations, calls, reports, strings };
}
function poolFor(data: ReturnType<typeof fixtures>, scope = { database: 'dive_trip_test', schema: 'workbench_live' }) {
  const release = vi.fn();
  const query = vi.fn(async ({ text, values }: { text: string; values?: string[] }) => {
    if (text.includes('current_database()')) return { rows: [scope] };
    if (text.includes('cloudflare-baseline-invocations')) return { rows: data.invocations };
    if (text.includes('cloudflare-baseline-calls')) return { rows: data.calls };
    if (text.includes('SELECT i.id')) return { rows: data.invocations.filter(i => i.trip_id === values?.[0]) };
    if (text.includes('SELECT c.invocation_id')) {
      const invs = data.invocations.filter(i => i.trip_id === values?.[0]);
      return { rows: data.calls.filter(c => invs.some(i => i.id === c.invocation_id || i.run_id === c.run_id)) };
    }
    return { rows: [] };
  });
  return { pool: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool, query, release };
}
async function withFixture(work: (dir: string, data: ReturnType<typeof fixtures>) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cf-history-test-')));
  try {
    const data = fixtures();
    await Promise.all(names.map((name, i) => writeFile(join(dir, name), data.strings[i])));
    await work(dir, data);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('first Cloudflare baseline includes fixed direct cost and all three product histories exactly once', () => withFixture(async (dir, data) => {
  const s = poolFor(data);
  const result = await readCloudflareCampaignBaseline(s.pool, accountId, dir);
  expect(result).toEqual({ chargedMicros: 3976, invocations: 6, modelCalls: 9, totalTokens: 36403,
    history: names.map((name, i) => ({ name, sha256: hash(data.strings[i]) })) });
  expect(JSON.stringify(result)).not.toContain(accountId);
  expect(s.query.mock.calls.every(([q]) => !/\b(INSERT|UPDATE|DELETE|DROP)\b/.test(q.text))).toBe(true);
  expect(await readFile(join(dir, names[1]), 'utf8')).toBe(data.strings[1]);
}));

test.each(['account', 'extra-invocation', 'extra-call', 'unknown', 'foreign-run', 'ledger-cost'] as const)(
  'fails closed on unaccounted workbench evidence: %s', failure => withFixture(async (dir, data) => {
    if (failure === 'account') data.invocations[0].account_id = 'b'.repeat(32);
    if (failure === 'extra-invocation') data.invocations.push({ ...data.invocations[0], id: id(99), run_id: id(98) });
    if (failure === 'extra-call') data.calls.push({ ...data.calls[0], call_id: 'unrecorded-call' });
    if (failure === 'unknown') data.calls[0].usage = null;
    if (failure === 'foreign-run') data.calls[0].run_id = id(99);
    if (failure === 'ledger-cost') data.invocations[0].actual_cost_micros = null;
    await expect(readCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  }));

test.each(['missing', 'symlink', 'directory', 'oversized', 'malformed', 'direct-usage', 'stopped-second', 'prior-hash', 'report-audit'] as const)(
  'bounded nofollow history rejects %s', failure => withFixture(async (dir, data) => {
    const path = join(dir, names[0]);
    if (failure === 'missing') await rm(path);
    if (failure === 'symlink') { await rm(path); await symlink(join(dir, names[1]), path); }
    if (failure === 'directory') { await rm(path); await mkdir(path); }
    if (failure === 'oversized') await writeFile(path, ' '.repeat(65537));
    if (failure === 'malformed') await writeFile(path, '{');
    if (failure === 'direct-usage') await writeFile(path, JSON.stringify({ ...data.reports[0], usage: { prompt_tokens: 160, completion_tokens: 230, total_tokens: 390 } }));
    if (failure === 'stopped-second') await writeFile(join(dir, names[2]), JSON.stringify({ ...data.reports[2], status: 'stopped' }));
    if (failure === 'prior-hash') await writeFile(join(dir, names[1]), `${data.strings[1]}\n`);
    if (failure === 'report-audit') await writeFile(join(dir, names[3]), JSON.stringify({ ...data.reports[3], audit: { complete: true } }));
    const s = poolFor(data);
    await expect(readCloudflareCampaignBaseline(s.pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  }));

test('fixed DB/schema and account validation never permit overrides or alternate accounts', () => withFixture(async (dir, data) => {
  for (const scope of [{ database: 'other', schema: 'workbench_live' }, { database: 'dive_trip_test', schema: 'public' }]) {
    await expect(readCloudflareCampaignBaseline(poolFor(data, scope).pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  }
  await expect(readCloudflareCampaignBaseline(poolFor(data).pool, `${accountId}\n`, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  await expect(readCloudflareCampaignBaseline(poolFor(data).pool, 'b'.repeat(32), dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
}));

test('symlinked artifacts directory is rejected, unrelated Gemini history is neither read nor reset', () => withFixture(async (dir, data) => {
  await writeFile(join(dir, 'live-evaluation-gemini.json'), 'unresolved unknown usage; deliberately not valid JSON');
  expect((await readCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir)).chargedMicros).toBe(3976);
  const alias = join(dir, 'alias'); await symlink(dir, alias);
  await expect(readCloudflareCampaignBaseline(poolFor(data).pool, accountId, alias)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  expect(await readFile(join(dir, 'live-evaluation-gemini.json'), 'utf8')).toContain('unresolved unknown usage');
}));

test.each(['first-phase', 'first-resumed', 'second-not-approved', 'owner', 'duplicate-call', 'direct-account', 'direct-failed'] as const)(
  'fixed first-campaign exception does not admit other history: %s', failure => withFixture(async (dir, data) => {
    if (failure === 'first-phase') await writeFile(join(dir, names[1]), JSON.stringify({ ...data.reports[1], phase: 'complete' }));
    if (failure === 'first-resumed') { data.invocations[0].run_status = 'succeeded'; data.invocations[0].decision = true; }
    if (failure === 'second-not-approved') data.invocations[1].decision = false;
    if (failure === 'owner') data.invocations[0].reservation_owner_id = id(99);
    if (failure === 'duplicate-call') data.calls[1] = { ...data.calls[0] };
    if (failure === 'direct-account') await writeFile(join(dir, names[0]), JSON.stringify({ ...data.reports[0], accountId: 'b'.repeat(32) }));
    if (failure === 'direct-failed') await writeFile(join(dir, names[0]), JSON.stringify({ ...data.reports[0], providerSuccess: false }));
    await expect(readCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
  }));

test('changing a report during DB audit is rejected even if its numeric totals stay the same', () => withFixture(async (dir, data) => {
  const s = poolFor(data), original = s.query.getMockImplementation()!;
  let changed = false;
  s.query.mockImplementation(async config => {
    if (config.text.includes('cloudflare-baseline-calls') && !changed) {
      changed = true; await writeFile(join(dir, names[3]), `${data.strings[3]}\n`);
    }
    return original(config);
  });
  await expect(readCloudflareCampaignBaseline(s.pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
}));

test('changing ledger evidence between audits cannot pass inventory comparison', () => withFixture(async (dir, data) => {
  const s = poolFor(data), original = s.query.getMockImplementation()!;
  let reads = 0;
  s.query.mockImplementation(async config => {
    if (config.text.includes('cloudflare-baseline-calls') && ++reads === 2) {
      data.calls[0] = { ...data.calls[0], usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
    return original(config);
  });
  await expect(readCloudflareCampaignBaseline(s.pool, accountId, dir)).rejects.toThrow('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID');
}));

test('failed DB acquisition exposes no raw connection details', () => withFixture(async (dir) => {
  const pool = { connect: vi.fn(async () => { throw new Error('private-connection-string'); }) } as unknown as Pool;
  await expect(readCloudflareCampaignBaseline(pool, accountId, dir)).rejects.toThrow(/^CLOUDFLARE_CAMPAIGN_HISTORY_INVALID$/);
}));

test('successor capture retains call identities even when legacy summaries and pinned reports agree', () => withFixture(async (dir, data) => {
  const before = await captureCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir);
  // Historical smoke summaries omit this identity; each independent read still
  // reconciles. The outer carry must now see the raw-row difference nonetheless.
  data.calls = data.calls.map((call, index) => index === 0 ? { ...call, call_id: 'changed-call-id' } : call);
  const after = await captureCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir);
  expect(after.baseline).toEqual(before.baseline);
  expect(after.raw).not.toEqual(before.raw);
  expect(before.raw.calls[0].call_id).toBe('call-0-0');
  expect(after.raw.calls[0].call_id).toBe('changed-call-id');
  expect(await readCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir)).toEqual(after.baseline);
}));

test('raw capture does not discard fields normalized away by schema projection', () => withFixture(async (dir, data) => {
  data.calls = data.calls.map(call => ({ ...call, unprojected: 'original' }));
  const before = await captureCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir);
  data.calls = data.calls.map(call => ({ ...call, unprojected: 'changed' }));
  const after = await captureCloudflareCampaignBaseline(poolFor(data).pool, accountId, dir);
  expect(after.baseline).toEqual(before.baseline);
  expect(before.raw.calls[0].unprojected).toBe('original');
  expect(after.raw.calls[0].unprojected).toBe('changed');
  expect(after.raw).not.toEqual(before.raw);
}));
