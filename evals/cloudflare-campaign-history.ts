import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS, cloudflareAccountSchema, matchesCloudflareModel } from '../src/agent/cloudflare-wire.ts';
import { referenceProviderCost } from '../src/server/model-cost.ts';
import { auditCloudflareSmoke } from '../tests/support/cloudflare-smoke-audit.ts';
import { withCloudflareAuditDatabase } from '../tests/support/cloudflare-audit-database.ts';

export type CloudflareCampaignBaseline = {
  chargedMicros: number; invocations: number; modelCalls: number; totalTokens: number;
  history: { name: string; sha256: string }[];
};
const names = ['cloudflare-gemma26b-smoke.json', 'cloudflare-product-smoke.json',
  'cloudflare-product-smoke-2.json', 'cloudflare-product-smoke-3.json'] as const;
const expected = [
  { calls: 2, tokens: 8871, cost: 952, invocations: 1, cumulativeCalls: 3, cumulativeTokens: 9260 },
  { calls: 3, tokens: 13603, cost: 1498, invocations: 2, cumulativeCalls: 6, cumulativeTokens: 22863 },
  { calls: 3, tokens: 13540, cost: 1441, invocations: 2, cumulativeCalls: 9, cumulativeTokens: 36403 },
] as const;
function fail(): never { throw new Error('CLOUDFLARE_CAMPAIGN_HISTORY_INVALID'); }
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({ promptTokens: natural, outputTokens: natural, totalTokens: natural });
const prior = z.object({ reportPath: z.string(), sha256: z.string().length(64).regex(/^[a-f0-9]+$/), modelCalls: natural, totalTokens: natural });
const directSchema = z.object({ model: z.literal(CLOUDFLARE_MODEL), startedAt: z.iso.datetime(), requestStartedAt: z.iso.datetime(),
  calls: z.literal(1), status: z.literal('tool-call-passed'), httpStatus: z.literal(200), providerSuccess: z.literal(true),
  returnedModel: z.string().refine(matchesCloudflareModel), errorCodes: z.array(z.unknown()).length(0), finishReason: z.literal('tool_calls'),
  toolCalls: z.array(z.object({ expectedName: z.literal(true), expectedArguments: z.literal(true) })).length(1),
  usage: z.object({ prompt_tokens: z.literal(160), completion_tokens: z.literal(229), total_tokens: z.literal(389) }),
  accountId: cloudflareAccountSchema.optional(),
});
const productSchema = z.object({ provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL), startedAt: z.iso.datetime(),
  status: z.enum(['stopped', 'passed']), phase: z.enum(['proposal', 'complete']), blocked: z.boolean(), agentPosts: natural,
  maxModelCalls: z.literal(7), modelQualityAccepted: z.literal(false), privateUsageComplete: z.literal(true),
  tripId: z.uuid(), attempt: natural.optional(), accountId: cloudflareAccountSchema.optional(),
  priorDirectSmoke: z.object({ modelCalls: z.literal(1), totalTokens: z.literal(389) }),
  priorProductSmoke: prior.optional(), priorSecondProductSmoke: prior.optional(),
  priorCumulative: z.object({ modelCalls: natural, totalTokens: natural }).optional(),
  cumulativeModelCallsIncludingDirectSmoke: natural, cumulativeTokensIncludingDirectSmoke: natural,
  audit: z.object({ complete: z.literal(true), modelCalls: natural, runId: z.uuid(), costMicros: natural, tokens,
    invocations: z.array(z.unknown()).min(1).max(2), calls: z.array(z.unknown()).min(1).max(7) }),
});

/** Fixed filenames only. Reject links, special files, oversized and changing files.
 * Never follow paths supplied inside reports. No directory-wide Gemini/history scan. */
async function readReport(directory: string, name: typeof names[number]) {
  if (await realpath(directory) !== directory) fail();
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await dir.stat();
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > 65_536) fail();
      const buffer = Buffer.alloc(65_537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (length !== before.size || length > 65_536 || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
      const check = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const current = await check.stat();
        if (current.dev !== identity.dev || current.ino !== identity.ino || await realpath(directory) !== directory) fail();
      } finally { await check.close(); }
      const bytes = buffer.subarray(0, length);
      return { name, sha256: createHash('sha256').update(bytes).digest('hex'),
        report: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
    } finally { await file.close(); }
  } finally { await dir.close(); }
}

const invocationSchema = z.object({ id: z.uuid(), run_id: z.uuid(), trip_id: z.uuid(), reservation_id: z.uuid(),
  provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL), account_id: cloudflareAccountSchema,
  kind: z.enum(['start', 'resume']), status: z.literal('settled'), reservation_status: z.literal('settled'),
  logical_run_id: z.uuid(), actual_cost_micros: z.string(), charged_cost_micros: z.string(),
  run_status: z.enum(['awaiting_confirmation', 'succeeded']), decision: z.boolean().nullable(),
  current_version: z.number().int(), reservation_owner_id: z.uuid(), trip_owner_id: z.uuid() });
const callSchema = z.object({ invocation_id: z.uuid(), run_id: z.uuid(), call_id: z.string().min(1).max(128),
  status: z.literal('completed'), usage: z.unknown(), provider_evidence: z.unknown() });

async function inventory(pool: Pool, accountId: string) {
  return withCloudflareAuditDatabase(pool, async query => {
    // Do not filter by expected account/run: that would hide extra dispatches.
    const rawInvocations = (await query(`/* cloudflare-baseline-invocations */
      SELECT i.id,i.run_id,r.trip_id,i.reservation_id,i.provider,i.model,i.account_id,i.kind,i.status,
        q.status AS reservation_status,q.logical_run_id,q.actual_cost_micros,q.charged_cost_micros,
        r.status AS run_status,r.decision,t.current_version,q.owner_id AS reservation_owner_id,t.owner_id AS trip_owner_id
      FROM workbench_live.agent_invocations i LEFT JOIN workbench_live.agent_runs r ON r.id=i.run_id
      LEFT JOIN workbench_live.trips t ON t.id=r.trip_id LEFT JOIN workbench_live.quota_reservations q ON q.id=i.reservation_id
      WHERE i.provider='cloudflare' ORDER BY i.id LIMIT 6`)).rows;
    const invocations = z.array(invocationSchema).length(5).parse(rawInvocations);
    const rawCalls = (await query(`/* cloudflare-baseline-calls */
      SELECT c.invocation_id,c.run_id,c.call_id,c.status,c.usage,c.provider_evidence FROM workbench_live.model_calls c
      WHERE c.provider_evidence->>'provider'='cloudflare'
        OR EXISTS (SELECT 1 FROM workbench_live.agent_invocations i
          WHERE i.provider='cloudflare' AND (i.id=c.invocation_id OR i.run_id=c.run_id))
      ORDER BY c.run_id,c.call_id LIMIT 9`)).rows;
    const calls = z.array(callSchema).length(8).parse(rawCalls);
    if (new Set(invocations.map(i => i.id)).size !== 5 || new Set(invocations.map(i => i.reservation_id)).size !== 5
      || invocations.some(i => i.account_id !== accountId || i.logical_run_id !== i.run_id || i.reservation_owner_id !== i.trip_owner_id)
      || new Set(calls.map(c => `${c.run_id}:${c.call_id}`)).size !== 8
      || calls.some(c => !invocations.some(i => i.id === c.invocation_id && i.run_id === c.run_id))) fail();
    return { invocations, calls, raw: { invocations: rawInvocations, calls: rawCalls } };
  });
}

/** First-campaign baseline only. The caller owns the exclusive campaign claim and
 * rejects any previous CF campaign; this function neither launches nor writes.
 * The legacy direct report has no account ID: it is a fixed historical allowance,
 * not independent account/billing proof. Product calls are all checked against DB.
 * Live callers must use the default directory; the third argument enables temp fixtures. */
export async function readCloudflareCampaignBaseline(pool: Pool, accountId: string,
  artifactsDirectory = '.artifacts'): Promise<CloudflareCampaignBaseline> {
  return (await captureCloudflareCampaignBaseline(pool, accountId, artifactsDirectory)).baseline;
}

/** Same bounded forensic read; retain unprojected selected rows for successors'
 * outer two-pass drift check. The legacy summary/report shape stays unchanged. */
export async function captureCloudflareCampaignBaseline(pool: Pool, accountId: string,
  artifactsDirectory = '.artifacts') {
  try {
    cloudflareAccountSchema.parse(accountId);
    const directory = resolve(artifactsDirectory);
    const reports = [];
    for (const name of names) reports.push(await readReport(directory, name));
    const direct = directSchema.parse(reports[0].report);
    if (direct.accountId !== undefined && direct.accountId !== accountId) fail();
    const directCost = referenceProviderCost('cloudflare', { promptTokens: direct.usage.prompt_tokens,
      outputTokens: direct.usage.completion_tokens, totalTokens: direct.usage.total_tokens },
    { provider: 'cloudflare', returnedModel: direct.returnedModel, priceBasis: CLOUDFLARE_PRICE_BASIS });
    if (directCost !== 85) fail();
    const products = reports.slice(1).map(file => productSchema.parse(file.report));
    for (const [index, report] of products.entries()) {
      const e = expected[index];
      if ((report.accountId !== undefined && report.accountId !== accountId)
        || report.status !== (index === 0 ? 'stopped' : 'passed') || report.phase !== (index === 0 ? 'proposal' : 'complete')
        || report.blocked !== (index === 0) || report.agentPosts !== e.invocations
        || report.attempt !== (index === 0 ? undefined : index + 1)
        || report.audit.modelCalls !== e.calls || report.audit.tokens.totalTokens !== e.tokens || report.audit.costMicros !== e.cost
        || report.audit.invocations.length !== e.invocations || report.audit.calls.length !== e.calls
        || report.cumulativeModelCallsIncludingDirectSmoke !== e.cumulativeCalls || report.cumulativeTokensIncludingDirectSmoke !== e.cumulativeTokens) fail();
      if (index === 0) {
        if (report.priorProductSmoke || report.priorSecondProductSmoke || report.priorCumulative) fail();
      } else {
        if (!isDeepStrictEqual(report.priorProductSmoke, { reportPath: `.artifacts/${names[1]}`, sha256: reports[1].sha256, modelCalls: 2, totalTokens: 8871 })
          || !isDeepStrictEqual(report.priorCumulative, { modelCalls: expected[index - 1].cumulativeCalls, totalTokens: expected[index - 1].cumulativeTokens })) fail();
        if (index === 1 && report.priorSecondProductSmoke) fail();
        if (index === 2 && !isDeepStrictEqual(report.priorSecondProductSmoke,
          { reportPath: `.artifacts/${names[2]}`, sha256: reports[2].sha256, modelCalls: 3, totalTokens: 13603 })) fail();
      }
    }
    if (new Set(products.map(p => p.tripId)).size !== 3 || new Set(products.map(p => p.audit.runId)).size !== 3) fail();
    const before = await inventory(pool, accountId);
    let chargedMicros = directCost, invocations = 1, modelCalls = 1, totalTokens = 389;
    for (const [index, report] of products.entries()) {
      const rows = before.invocations.filter(i => i.run_id === report.audit.runId);
      if (rows.length !== expected[index].invocations || rows.some(i => i.trip_id !== report.tripId
        || i.run_status !== (index === 0 ? 'awaiting_confirmation' : 'succeeded')
        || i.decision !== (index === 0 ? null : true) || i.current_version !== (index === 0 ? 1 : 2))) fail();
      const audit = await auditCloudflareSmoke(pool, report.tripId, accountId);
      if (!audit.complete || audit.costMicros === null || !audit.tokens || !isDeepStrictEqual(audit, report.audit)) fail();
      chargedMicros += audit.costMicros; invocations += audit.invocations.length;
      modelCalls += audit.modelCalls; totalTokens += audit.tokens.totalTokens;
    }
    if (!isDeepStrictEqual(before, await inventory(pool, accountId))) fail();
    for (const original of reports) if ((await readReport(directory, original.name)).sha256 !== original.sha256) fail();
    if (chargedMicros !== 3976 || invocations !== 6 || modelCalls !== 9 || totalTokens !== 36403) fail();
    return { baseline: { chargedMicros, invocations, modelCalls, totalTokens,
      history: reports.map(({ name, sha256 }) => ({ name, sha256 })) }, raw: before.raw };
  } catch { return fail(); }
}
