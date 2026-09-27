import cases from './cases.json' with { type: 'json' };
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT, campaignPreflight } from './campaign-policy.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../src/agent/cloudflare-wire.ts';
import type { RecordedEvaluationV2 } from './collector.ts';
import { gradeEvidenceV2 } from './evidence.ts';

export const CLOUDFLARE_CAMPAIGN_AUTHORIZATION = 'first-30-cases-cloudflare-free-tier-confirmed';
export type CampaignBaseline = { chargedMicros: number; invocations: number; modelCalls: number; totalTokens: number };
type Result = RecordedEvaluationV2;
export type CampaignCapture = { chargedMicros: number; modelCalls: number; totalTokens: number | null;
  privateUsageComplete: boolean; usageKnown: boolean; record: Record<string, unknown> };
export type CloudflareCampaignReport = {
  schemaVersion: 2;
  model: typeof CLOUDFLARE_MODEL; accountId: string; transport: 'real-cloudflare-via-http-handler';
  budgetMicros: number; maxModelCalls: 210; prior: CampaignBaseline;
  chargedMicros: number; invocations: number; modelCalls: number; totalTokens: number | null;
  cumulativeChargedMicros: number; cumulativeInvocations: number;
  cumulativeModelCalls: number; cumulativeTokens: number | null;
  stopped: string | null; textReview: 'pending'; evaluationGatePassed: false; records: unknown[];
};
type CampaignPorts = {
  accountId: string; prior: CampaignBaseline;
  execute(caseId: string, beforeDispatch: (signal: AbortSignal) => Promise<void>): Promise<Result>;
  capture(): Promise<CampaignCapture>;
  checkpoint(report: CloudflareCampaignReport): Promise<void>;
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
};

type FiniteReport = Omit<CloudflareCampaignReport, 'maxModelCalls' | 'prior'> & {
  maxModelCalls: number;
  prior: Omit<CampaignBaseline, 'totalTokens'> & { totalTokens: number | null };
};
export type FiniteCampaignPorts<R extends FiniteReport> = Pick<CampaignPorts, 'execute' | 'capture' | 'pause' | 'now'> & {
  checkpoint(report: R): Promise<void>;
  /** Successor history/lock gate after spacing, before a dispatch is counted. */
  checkDispatch?(signal: AbortSignal): Promise<void>;
  /** Closed successor's task predicate, checked for EVERY completed slot.
   * Pending human review is not an automatic task pass or failure. */
  checkResult?(result: Result): boolean;
};
export type CampaignSlot = { round: number; caseId: string; maxDispatches?: 1 | 2 };
type FiniteSchedule = {
  slots: readonly CampaignSlot[];
  maxInvocations: number;
};

function verifyResult(result: Result, caseId: string, dispatches: number, runIds: Set<string>) {
  const e = result.evidence;
  if (result.schemaVersion !== 2 || e.caseId !== caseId || e.usageRunId !== e.runId || runIds.has(e.runId)
    || !Number.isSafeInteger(e.modelCalls) || !Number.isFinite(e.latencyMs) || e.latencyMs < 0
    || (e.costMicros !== null && (!Number.isSafeInteger(e.costMicros) || e.costMicros < 0))
    || dispatches < 1 || (e.runStatus === 'succeeded' && dispatches !== (e.decision === 'accept' ? 2 : 1))) {
    throw new Error('EVAL_EVIDENCE_STOP');
  }
  runIds.add(e.runId);
  // Recompute safety from evidence, so a supplied empty grade cannot hide it.
  if (gradeEvidenceV2(e, CLOUDFLARE_MODEL).safetyFailures.length && !result.grade.safetyFailures.length) {
    throw new Error('EVAL_EVIDENCE_STOP');
  }
}

function verifyCapture(captured: CampaignCapture, previous: FiniteReport, result: Result | undefined, dispatches: number) {
  const calls = captured.modelCalls - previous.modelCalls;
  const cost = captured.chargedMicros - previous.chargedMicros;
  if (![captured.chargedMicros, captured.modelCalls].every(value => Number.isSafeInteger(value) && value >= 0)
    || cost < 0 || calls < 0 || captured.modelCalls > previous.maxModelCalls
    || (captured.totalTokens !== null && (!Number.isSafeInteger(captured.totalTokens) || captured.totalTokens < 0))
    || calls > 7 || (dispatches === 0 && calls !== 0) || captured.privateUsageComplete !== true
    || typeof captured.usageKnown !== 'boolean' || captured.usageKnown !== (captured.totalTokens !== null)
    || (captured.totalTokens !== null && previous.totalTokens !== null && captured.totalTokens < previous.totalTokens)
    || (result && (calls !== result.evidence.modelCalls
      || (result.evidence.usageComplete && result.evidence.costMicros !== null
        && captured.usageKnown && cost !== result.evidence.costMicros)))) {
    throw new Error('EVAL_CAPTURE_INVALID');
  }
}

/** Finite evaluation scheduler, NOT an agent loop. Each case uses collectCase's
 * HTTP admission/native ADK path. No retries, credentials, DB or IO here. */
export async function runCloudflareCampaign(ports: CampaignPorts): Promise<CloudflareCampaignReport> {
  cloudflareAccountSchema.parse(ports.accountId);
  const { chargedMicros, invocations, modelCalls, totalTokens } = ports.prior;
  const prior = { chargedMicros, invocations, modelCalls, totalTokens };
  if (!Object.values(prior).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('EVAL_INVALID_HISTORY');
  campaignPreflight(prior, maximumProviderModelCost('cloudflare'));
  const report: CloudflareCampaignReport = { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId,
    transport: 'real-cloudflare-via-http-handler', budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 210,
    prior: { ...prior }, chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: prior.totalTokens,
    stopped: null, textReview: 'pending', evaluationGatePassed: false, records: [] };
  return runFiniteCloudflareCampaign(ports, report, {
    slots: [1, 2, 3].flatMap(round => cases.map(spec => ({ round, caseId: spec.id }))), maxInvocations: 60,
  });
}

/** Shared finite kernel. Policies and provenance belong to the fixed wrappers;
 * injected ports are trusted adapters, never an authorization capability. */
export async function runFiniteCloudflareCampaign<R extends FiniteReport>(
  ports: FiniteCampaignPorts<R>, report: R, schedule: FiniteSchedule,
): Promise<R> {
  if (report.schemaVersion !== 2) throw new Error('EVAL_REPORT_VERSION_REQUIRED');
  if (schedule.slots.some(slot => slot.maxDispatches !== undefined && ![1, 2].includes(slot.maxDispatches))) {
    throw new Error('EVAL_INVALID_SCHEDULE');
  }
  const prior = report.prior;
  const runIds = new Set<string>();
  // A reviewed campaign enters this kernel twice with the same report. Keep
  // uniqueness campaign-wide without a second wrapper-owned registry.
  for (const row of report.records) {
    if (!row || typeof row !== 'object' || !('evidence' in row)) continue;
    const evidence = row.evidence;
    if (!evidence || typeof evidence !== 'object' || !('runId' in evidence)
      || typeof evidence.runId !== 'string' || !evidence.runId || runIds.has(evidence.runId)) {
      throw new Error('EVAL_EVIDENCE_STOP');
    }
    runIds.add(evidence.runId);
  }
  let lastDispatch = ports.now();
  const save = () => ports.checkpoint(structuredClone(report));
  await save(); // Persistent pending report before any execution.
  for (const { round, caseId, maxDispatches = 2 } of schedule.slots) {
    if (!report.stopped && report.cumulativeChargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) {
      report.stopped = 'BUDGET_STOP';
    }
    if (report.stopped) {
      report.records.push({ round, caseId, outcome: 'skipped', reason: report.stopped });
      continue;
    }
    let dispatches = 0;
    let result: Result | undefined;
    try {
      result = await ports.execute(caseId, async signal => {
        signal.throwIfAborted();
        if (dispatches >= maxDispatches || report.invocations >= schedule.maxInvocations
          || report.cumulativeInvocations >= CAMPAIGN_INVOCATION_LIMIT) throw new Error('EVAL_INVOCATION_STOP');
        await ports.pause(Math.max(0, 15_000 - (ports.now() - lastDispatch)), signal);
        signal.throwIfAborted();
        await ports.checkDispatch?.(signal);
        signal.throwIfAborted();
        dispatches++; report.invocations++; report.cumulativeInvocations++;
        await save(); // Persist conservative dispatch count before sending HTTP.
        signal.throwIfAborted();
        // History/checkpoint time is not elapsed spacing for the next dispatch.
        lastDispatch = ports.now();
      });
      verifyResult(result, caseId, dispatches, runIds);
      report.records.push({ round, caseId,
        outcome: result.evidence.runStatus === 'succeeded' ? 'completed' : 'failed', ...result });
      if (result.evidence.model !== CLOUDFLARE_MODEL || result.evidence.modelCalls < 1 || result.evidence.modelCalls > 7) report.stopped = 'BINDING_OR_LIMIT_STOP';
      else if (!result.evidence.usageComplete || result.evidence.costMicros === null) report.stopped = 'UNKNOWN_USAGE_STOP';
      else if (result.evidence.runStatus !== 'succeeded') report.stopped = 'FAILED_RUN_STOP';
      else if (result.grade.safetyFailures.length) report.stopped = 'SAFETY_EVIDENCE_STOP';
      else if (result.evidence.latencyMs >= 60_000) report.stopped = 'DEADLINE_STOP';
      else if (ports.checkResult) {
        try {
          if (ports.checkResult(structuredClone(result)) !== true) report.stopped = 'GOAL_EVIDENCE_STOP';
        } catch { report.stopped = 'GOAL_EVIDENCE_STOP'; }
      }
    } catch (error) {
      report.stopped = error instanceof Error && /^EVAL_[A-Z_]+$/.test(error.message) ? error.message : 'EVAL_EXCEPTION_STOP';
      report.records.push({ round, caseId, outcome: 'failed', reason: report.stopped, costMicros: null });
    }
    // Capture and checkpoint inside the isolated DB lifetime. Any inability to
    // retain evidence throws, so withDatabase(retainOnFailure) keeps that schema.
    await save();
    try {
      const captured = await ports.capture();
      report.records.push({ ...captured.record, kind: 'durable-audit', round, caseId });
      verifyCapture(captured, report, result, dispatches);
      report.chargedMicros = captured.chargedMicros; report.modelCalls = captured.modelCalls;
      report.totalTokens = captured.totalTokens;
      report.cumulativeChargedMicros = prior.chargedMicros + captured.chargedMicros;
      report.cumulativeModelCalls = prior.modelCalls + captured.modelCalls;
      report.cumulativeTokens = captured.totalTokens === null || prior.totalTokens === null ? null : prior.totalTokens + captured.totalTokens;
      if (![report.cumulativeChargedMicros, report.cumulativeModelCalls,
        ...(report.cumulativeTokens === null ? [] : [report.cumulativeTokens])].every(Number.isSafeInteger)) {
        throw new Error('EVAL_CAPTURE_INVALID');
      }
      if (!captured.usageKnown) report.stopped = 'UNKNOWN_USAGE_STOP';
      if (report.cumulativeChargedMicros > CAMPAIGN_BUDGET_MICROS) report.stopped = 'BUDGET_STOP';
      await save();
    } catch {
      report.stopped = 'EVIDENCE_EXPORT_STOP';
      await save();
      throw new Error('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
    }
  }
  await save();
  return report;
}
