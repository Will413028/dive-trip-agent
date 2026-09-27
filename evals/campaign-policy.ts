import { z } from 'zod';
import cases from './cases.json' with { type: 'json' };

export const CAMPAIGN_BUDGET_MICROS = 3_000_000;
// Conservative across retained campaigns, not reset by a fresh test schema/day.
export const CAMPAIGN_INVOCATION_LIMIT = 100;
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reportSchema = z.object({ model: z.string(), stopped: z.null(), chargedMicros: natural, invocations: natural.optional(),
  transport: z.literal('real-gemini-via-http-handler'), records: z.array(z.unknown()) });
const attemptSchema = z.object({ round: z.number().int().min(1).max(3), caseId: z.string(),
  outcome: z.literal('completed'), evidence: z.object({ runId: z.string().uuid(),
    model: z.string(), runStatus: z.literal('succeeded'), usageComplete: z.literal(true),
    costMicros: natural, decision: z.enum(['accept', 'none']) }),
  grade: z.object({ safetyFailures: z.array(z.string()).length(0) }) });

/** Trusted local history only, not a signature or a billing/account quota API.
 * Incomplete/unknown/stopped history blocks another batch rather than resetting it.
 * Reports keep their own chargedMicros; never sum a cumulative field twice. */
export function carryCampaignUsage(reports: unknown[], model: string) {
  const runIds = new Set<string>();
  let chargedMicros = 0, invocations = 0;
  for (const raw of reports) {
    const report = reportSchema.parse(raw);
    if (report.model !== model) throw new Error('EVAL_HISTORY_MODEL_MISMATCH');
    for (const record of report.records) {
      const audit = z.object({ kind: z.literal('durable-audit'), privateUsageComplete: z.boolean().optional() }).safeParse(record);
      if (audit.success && audit.data.privateUsageComplete === false) throw new Error('EVAL_HISTORY_PRIVATE_USAGE_INCOMPLETE');
    }
    const attempts = report.records.filter(record => !z.object({ kind: z.literal('durable-audit') }).safeParse(record).success)
      .map(record => attemptSchema.parse(record));
    const pairs = new Set(attempts.map(a => `${a.round}:${a.caseId}`));
    if (attempts.length !== 30 || pairs.size !== 30 || attempts.some(a => !cases.some(c => c.id === a.caseId))) {
      throw new Error('EVAL_HISTORY_INCOMPLETE');
    }
    let cost = 0, dispatches = 0;
    for (const attempt of attempts) {
      const e = attempt.evidence;
      if (e.model !== model || runIds.has(e.runId)) throw new Error('EVAL_HISTORY_BINDING_INVALID');
      runIds.add(e.runId);
      cost += e.costMicros;
      dispatches += e.decision === 'accept' ? 2 : 1;
    }
    if (!Number.isSafeInteger(cost) || cost !== report.chargedMicros) throw new Error('EVAL_HISTORY_COST_MISMATCH');
    if (report.invocations !== undefined && report.invocations !== dispatches) throw new Error('EVAL_HISTORY_INVOCATION_MISMATCH');
    invocations += dispatches;
    chargedMicros += cost;
    if (!Number.isSafeInteger(chargedMicros)) throw new Error('EVAL_HISTORY_COST_MISMATCH');
  }
  return { chargedMicros, invocations };
}

export function campaignPreflight(prior: { chargedMicros: number; invocations: number }, reservationMicros: number) {
  if (![prior.chargedMicros, prior.invocations, reservationMicros].every(n => Number.isSafeInteger(n) && n >= 0)
    || reservationMicros === 0) throw new Error('EVAL_INVALID_BUDGET');
  if (prior.chargedMicros + reservationMicros > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_CUMULATIVE_BUDGET_STOP');
  // Reserve worst-case start+resume for every planned case before any credential read.
  if (prior.invocations + 60 > CAMPAIGN_INVOCATION_LIMIT) throw new Error('EVAL_CUMULATIVE_INVOCATION_STOP');
}
