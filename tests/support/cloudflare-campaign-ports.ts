import { randomBytes } from 'node:crypto';
import { CAMPAIGN_BUDGET_MICROS } from '../../evals/campaign-policy';
import { waitForCloudflareCampaignDrain } from '../../evals/cloudflare-campaign-drain';
import { collectCase } from '../../evals/collector';
import { auditAcceptedAnswerUsage } from '../../evals/usage';
import { exportUsageEvidence } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import type { OfflineScenario } from '../../src/agent/runtime';
import type { AgentServerContext, GroundedCloudflareEvaluationCampaign } from '../../src/server/agent-policy';
import { database } from '../../src/server/db';
import { handleRequest } from '../../src/server/http';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';

export type CloudflareCampaignPortsOptions = {
  accountId: string;
  priorChargedMicros: number;
  loadCredential: () => Promise<string>;
  /** Server-only test selection: uses the existing fetch-intercepting worker.
   * Omit for an independently authorized live caller. Never derive from HTTP. */
  offlineScenario?: OfflineScenario;
  /** Only the newly authorized one-shot entry selects the grounded contract. */
  liveCampaign?: GroundedCloudflareEvaluationCampaign;
  captureReplay?: Parameters<typeof collectCase>[1]['captureReplay'];
};

/** Create once inside the caller's isolated withDatabase lifetime. Call execute
 * then capture once per case, sequentially, including after execute rejects.
 * The caller owns authorization, history, claims, checkpoints and scheduling;
 * constructing these ports neither loads credentials nor dispatches a worker. */
export function createCloudflareCampaignPorts({ accountId, priorChargedMicros, loadCredential,
  offlineScenario, liveCampaign, captureReplay }: CloudflareCampaignPortsOptions) {
  if (offlineScenario !== undefined && liveCampaign !== undefined) throw new Error('EVAL_INVALID_CAMPAIGN_CONTEXT');
  const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId } as const;
  const hashingKey = randomBytes(32);
  let current: { ownerId: string; tripId: string } | undefined;
  let totalTokens = 0;
  return {
    execute: async (caseId: string, beforeDispatch: (signal: AbortSignal) => Promise<void>) => {
      current = undefined;
      const owner = await createSession();
      const context: Exclude<AgentServerContext, { provider: 'fixture' }> = {
        ...binding, ...(offlineScenario === undefined ? { liveLocal: true as const } : { offlineScenario }),
        verifiedPeerAddress: '127.0.0.1', hashingKey,
        quota: { enabled: true, priceBasis: offlineScenario === undefined ? 'server-verified' : 'synthetic',
          dailyBudgetMicros: CAMPAIGN_BUDGET_MICROS - priorChargedMicros, reservationTtlMs: 60_000 },
        loadCredential,
      };
      return collectCase(caseId, { model: CLOUDFLARE_MODEL, faultSupported: true, captureReplay,
        setup: async input => {
          context.evaluation = { catalog: input.catalog, lookupTimeout: input.fault === 'catalog-timeout',
            ...(offlineScenario === undefined ? { liveCampaign: liveCampaign ?? 'cloudflare-30-cases' as const } : {}) };
          const trip = await createTrip(owner.id, input.before);
          current = { ownerId: owner.id, tripId: trip.id };
          return trip;
        },
        request: async (path, body, signal) => {
          if (path.endsWith('/agent')) await beforeDispatch(signal);
          return handleRequest(new Request(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST',
            headers: { cookie: `dive_trip_session=${owner.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal }), 'http://localhost', context);
        },
        audit: runId => auditAcceptedAnswerUsage(database(), owner.id, current!.tripId, runId, binding),
      });
    },
    capture: async () => {
      // handleRequest returns a stream; cancellation may still be settling.
      const tripId = current?.tripId ?? '00000000-0000-0000-0000-000000000000';
      const quiescent = current !== undefined && await waitForCloudflareCampaignDrain(database(), tripId);
      const runs = await database().query<{ id: string }>('SELECT id,status,proposal_id,interrupt_id,decision FROM agent_runs WHERE trip_id=$1', [tripId]);
      const events = await database().query(`SELECT e.run_id,e.sequence,e.event FROM agent_run_events e
        JOIN agent_runs r ON r.id=e.run_id WHERE r.trip_id=$1 ORDER BY e.sequence`, [tripId]);
      const totals = await database().query<{ charged: string; calls: string }>(`SELECT
        (SELECT COALESCE(sum(charged_cost_micros),0)::text FROM quota_reservations) AS charged,
        (SELECT count(*)::text FROM model_calls) AS calls`);
      const privateUsage = [];
      let usageKnown = runs.rows.length === 1 && quiescent;
      for (const run of runs.rows) {
        const evidence = await exportUsageEvidence(database(), current!.ownerId, tripId, run.id, binding);
        const audit = await auditAcceptedAnswerUsage(database(), current!.ownerId, tripId, run.id, binding);
        privateUsage.push(evidence);
        usageKnown &&= audit.complete;
        for (const call of evidence.calls) totalTokens += call.usage?.totalTokens ?? 0;
      }
      const chargedMicros = Number(totals.rows[0].charged);
      return { chargedMicros, modelCalls: Number(totals.rows[0].calls),
        totalTokens: usageKnown ? totalTokens : null, usageKnown, privateUsageComplete: quiescent,
        record: { runs: runs.rows, events: events.rows, chargedMicros, privateUsage,
          privateUsageComplete: quiescent, quiescent } };
    },
  };
}
