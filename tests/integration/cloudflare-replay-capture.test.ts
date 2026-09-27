import { EventType } from '@ag-ui/core';
import { expect, test, vi } from 'vitest';
import { evaluationInput } from '../../evals/fixtures';
import { parseReplayBundle, type ReplayBundle } from '../../evals/replay-bundle';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { database } from '../../src/server/db';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';

// Real HTTP -> collector -> native ADK/Postgres worker -> public projections.
// Only provider fetch is synthetic, via the existing fixed offline bootstrap.
// No local/live loader, environment reads, network model calls or sidecar writes.
const accountId = 'a'.repeat(32);
const placeholder = 'offline-placeholder-not-a-credential';

test.each([
  { scenario: 'proposal' as const, caseId: 'free-afternoon', dispatches: 2, calls: 2 },
  { scenario: 'clarify' as const, caseId: 'ambiguous', dispatches: 1, calls: 1 },
])('Cloudflare $scenario public capture survives strict replay parsing and durable audit',
  ({ scenario, caseId, dispatches, calls }) => withDatabase(async () => {
    const input = evaluationInput(caseId);
    const bundles: ReplayBundle[] = [];
    // Synchronous in-memory callback, matching the campaign sidecar handoff.
    const captureReplay = vi.fn((bundle: ReplayBundle) => { bundles.push(bundle); });
    const loadCredential = vi.fn(async () => placeholder);
    const beforeDispatch = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: 188_267,
      offlineScenario: scenario, loadCredential, captureReplay });
    expect(loadCredential).not.toHaveBeenCalled();
    expect(captureReplay).not.toHaveBeenCalled();

    // In particular, an over-strict capture validator must not make this valid
    // real collector call reject after the actual run has already succeeded.
    const result = await ports.execute(caseId, beforeDispatch);
    expect(captureReplay).toHaveBeenCalledTimes(1);
    expect(bundles).toHaveLength(1);
    expect(beforeDispatch).toHaveBeenCalledTimes(dispatches);
    expect(loadCredential).toHaveBeenCalledOnce();
    expect(result.evidence).toMatchObject({ model: CLOUDFLARE_MODEL, runStatus: 'succeeded',
      usageComplete: true, modelCalls: calls, textReview: 'pending',
      beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: scenario === 'proposal' ? 2 : 1,
      decision: scenario === 'proposal' ? 'accept' : 'none' });
    // Proposal resume ends at its native receipt (no model/final tool); an
    // initial clarification still uses the invisible native final tool.
    expect(result.evidence.toolCount).toBe(result.evidence.visibleToolCount + (scenario === 'clarify' ? 1 : 0));

    // Reparse serialized callback output, not a hand-authored replay fixture.
    const bundle = parseReplayBundle(JSON.parse(JSON.stringify(bundles[0])));
    expect(bundle).toEqual(bundles[0]);
    expect(bundle).toMatchObject({ schemaVersion: 2, caseId, inputDigest: input.digest,
      prompt: input.prompt, catalog: input.catalog, model: CLOUDFLARE_MODEL });
    expect(bundle.initial.runs).toEqual({ runs: [] });
    expect(bundle.initial.trip.snapshot).toEqual(result.evidence.before);
    expect(bundle.afterStart.trip).toEqual(bundle.initial.trip);
    expect(bundle.final.trip.snapshot).toEqual(result.evidence.after);
    expect(bundle.final.trip.version).toBe(result.evidence.afterVersion);
    expect(bundle.afterStart.runs.runs).toHaveLength(1);
    expect(bundle.final.runs.runs).toHaveLength(1);
    const pending = bundle.afterStart.runs.runs[0];
    const final = bundle.final.runs.runs[0];
    expect(pending).toMatchObject({ id: result.evidence.runId, tripId: bundle.initial.trip.id,
      baseVersion: 1, message: input.prompt, decision: null, answerContractVersion: 1 });
    expect(final).toMatchObject({ id: pending.id, tripId: pending.tripId,
      requestId: pending.requestId, status: 'succeeded' });
    expect(bundle.startEvents[0]).toMatchObject({ type: EventType.RUN_STARTED,
      threadId: pending.tripId, runId: pending.requestId });
    expect(bundle.startEvents.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(pending.events.map(row => row.event)).toEqual(bundle.startEvents);
    expect([...bundle.startEvents, ...bundle.resumeEvents]).toEqual(result.events);
    expect(final.events.map(row => row.event)).toEqual(result.events);

    // The caller saves its sidecar only after this real drain/durable capture.
    const durable = await ports.capture();
    expect(durable).toMatchObject({ modelCalls: calls, usageKnown: true,
      privateUsageComplete: true, record: { quiescent: true } });
    expect(durable.record.events.map(row => row.event)).toEqual(result.events);
    expect(final.events).toEqual(durable.record.events.map(row => ({
      sequence: row.sequence, event: row.event,
    })));
    expect(durable.record.runs).toHaveLength(1);
    expect(durable.record.runs[0]).toMatchObject({ id: pending.id, status: 'succeeded' });
    expect(captureReplay).toHaveBeenCalledTimes(1);

    if (scenario === 'proposal') {
      expect(pending).toMatchObject({ status: 'awaiting_confirmation',
        proposalId: result.evidence.proposalId, proposal: { base: bundle.initial.trip,
          draft: { canApply: true, next: result.evidence.after } } });
      expect(pending.interruptId).toEqual(expect.any(String));
      expect(bundle.resumeEvents[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: pending.tripId });
      expect(bundle.resumeEvents.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(final).toMatchObject({ decision: true, proposalId: pending.proposalId });
      const saved = await database().query('SELECT draft FROM proposals WHERE id=$1', [pending.proposalId]);
      expect(saved.rows).toHaveLength(1);
      expect(pending.proposal?.draft).toEqual(saved.rows[0].draft);
      expect(final.proposal).toEqual(pending.proposal);
      // The synthetic worker changes pace. Protocol capture success must not
      // turn its missed free-afternoon goal into model-quality acceptance.
      expect(result.grade.pass).toBe(false);
      expect(result.grade.reasons).toContain('GOAL_MISSED');
    } else {
      expect(pending).toMatchObject({ status: 'succeeded', proposalId: null, interruptId: null });
      expect(pending.proposal).toBeUndefined();
      expect(bundle.resumeEvents).toEqual([]);
      expect(bundle.final).toEqual(bundle.afterStart);
      expect(bundle.final.trip).toEqual(bundle.initial.trip);
      expect(bundle.startEvents.some(event => event.type === EventType.CUSTOM && event.name === 'dive_trip.answer.v1')).toBe(true);
      expect(bundle.startEvents.some(event => event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(false);
    }

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(placeholder);
    expect(serialized).not.toContain(accountId);
    expect(serialized).not.toMatch(/dive_trip_session|privateUsage|promptTokens|provider_evidence|hashingKey/);
    // The callback value is detached from the result used by campaign grading.
    bundles[0].final.trip.version = 999;
    expect(result.evidence.afterVersion).toBe(scenario === 'proposal' ? 2 : 1);
  }), 90_000);
