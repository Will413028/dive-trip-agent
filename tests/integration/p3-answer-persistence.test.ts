import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { afterEach, expect, test, vi } from 'vitest';
import * as compiler from '../../src/agent/answer-compiler';
import { receiptEvidence } from '../../src/agent/answer-evidence';
import { executeAgent } from '../../src/agent/runtime';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { buildProposal } from '../../src/domain/proposal';
import { chatAgent, chatReplay, chatRuns } from '../../src/server/chat-http';
import { database, makePool, withDatabasePool } from '../../src/server/db';
import { appendRunEvent, bindProposal, claimResume, finishRun, getRun, listRuns, startRun } from '../../src/server/run-store';
import { createSession } from '../../src/server/session';
import { createTrip, getTrip } from '../../src/server/trip-store';
import { applyProposal, rejectProposal, restoreVersion, saveProposal } from '../../src/server/version-store';
import { testDatabaseUrl, withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { awaitConfirmation, proposalAnswer, recordSimpleAnswer, startAnswerPhase } from './p3-fixtures';

// These DB tests exercise product transactions and transport faults, never ADK
// or a provider. The separate runtime suite owns worker/process verification.
vi.mock('../../src/agent/runtime', () => ({ executeAgent: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const owner = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  const { run } = await startRun(owner.id, trip.id, 'request', '第二天下午留白', 1);
  const binding = { ownerId: owner.id, tripId: trip.id, runId: run.id, baseVersion: 1 };
  const value = compiler.compileAnswer({ version: '1', answer: { kind: 'clarify', fields: ['dates'] } }, {
    binding, eventId: 'final', evidence: [],
  });
  return { owner, trip, run, event: { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value } };
}
async function expire(runId: string) {
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [runId]);
}
async function pending() {
  const f = await setup();
  const items = f.trip.snapshot.entries.map(entry => entry.item);
  const draft = buildProposal(f.trip.snapshot, [{ kind: 'remove', entryId: 'transfer' }], items, 'agent');
  const proposalId = await saveProposal(f.owner.id, f.trip.id, 1, draft, items);
  await awaitConfirmation(f.owner.id, f.trip.id, f.run.id, proposalId);
  return { ...f, proposalId };
}
async function decision(confirmed: boolean) {
  const f = await pending(), proposalId = f.proposalId;
  await claimResume(f.owner.id, f.trip.id, f.run.id, 'gate', confirmed);
  await startAnswerPhase(f.owner.id, f.trip.id, f.run.id);
  const receipt = confirmed
    ? { status: 'applied' as const, version: (await applyProposal(f.owner.id, { tripId: f.trip.id, proposalId,
      requestId: `agent:${f.run.id}`, baseVersion: 1 }, f.run.id)).version }
    : await rejectProposal(f.owner.id, f.trip.id, proposalId, f.run.id);
  return { ...f, proposalId, receipt: receipt! };
}
function answers(events: { event: BaseEvent }[]) {
  return events.flatMap(({ event }) => event.type === EventType.CUSTOM
    ? [acceptedAnswerSchema.parse(event.value)] : []).filter(answer => answer.body.kind !== 'proposal');
}

test('P3 ACK lost / concurrent duplicate: same answerId returns its immutable saved sequence', () => withDatabase(async () => {
  const { owner, trip, run, event } = await setup();
  const started = await startAnswerPhase(owner.id, trip.id, run.id);
  const first = await appendRunEvent(owner.id, trip.id, run.id, event);
  // The write committed, but the caller never got its ACK. Retrying the same
  // envelope must return that write, including across independent connections.
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const pool = makePool(testDatabaseUrl(), schema);
  try {
    const retries = await withDatabasePool(pool, () => Promise.all(Array.from({ length: 8 }, () =>
      appendRunEvent(owner.id, trip.id, run.id, structuredClone(event)))));
    expect(retries).toEqual(Array.from({ length: 8 }, () => first));
  } finally { await pool.end(); }
  const changed = { ...event, value: { ...event.value, body: { kind: 'unsupported', reason: 'booking' } } };
  await expect(appendRunEvent(owner.id, trip.id, run.id, changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await getRun(owner.id, trip.id, run.id))?.events).toEqual([started, first]);
  await finishRun(owner.id, trip.id, run.id, { status: 'succeeded' });
  await expect(appendRunEvent(owner.id, trip.id, run.id, event)).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
}));

test('P3 receiving store rejects foreign binding, raw text and private payloads before any write', () => withDatabase(async () => {
  const { owner, trip, run, event } = await setup();
  for (const raw of [
    { ...event, value: { ...event.value, runId: randomUUID() } },
    { ...event, rawEvent: { privateEvidence: 'private' } },
    { ...event, value: { ...event.value, templateVersion: 2 } },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'raw', delta: 'raw text' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tool', delta: 'private' },
    { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'tool', role: 'tool', content: 'private' },
  ]) await expect(appendRunEvent(owner.id, trip.id, run.id, raw)).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  expect((await getRun(owner.id, trip.id, run.id))?.events).toEqual([]);
}));

test('P3 success needs a current-phase answer: no event, progress, old answers and duplicate ACKs are not proof', () => withDatabase(async () => {
  const f = await setup();
  const finish = () => finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'succeeded' });
  await expect(finish()).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await appendRunEvent(f.owner.id, f.trip.id, f.run.id, { type: EventType.TOOL_CALL_END, toolCallId: 'progress' });
  await expect(finish()).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await appendRunEvent(f.owner.id, f.trip.id, f.run.id, f.event);
  await expect(finish()).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await startAnswerPhase(f.owner.id, f.trip.id, f.run.id);
  await appendRunEvent(f.owner.id, f.trip.id, f.run.id, f.event);
  await expect(finish()).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await recordSimpleAnswer(f.owner.id, f.trip.id, f.run.id);
  expect((await finish()).status).toBe('succeeded');
}));

test('P3 failure answers cannot become success, including after an extra valid answer', () => withDatabase(async () => {
  const f = await setup();
  await startAnswerPhase(f.owner.id, f.trip.id, f.run.id);
  const value = compiler.compileFailure({ binding: { ownerId: f.owner.id, tripId: f.trip.id, runId: f.run.id, baseVersion: 1 },
    eventId: 'worker-failure', evidence: [] });
  await appendRunEvent(f.owner.id, f.trip.id, f.run.id, { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value });
  await expect(finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'succeeded' })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await recordSimpleAnswer(f.owner.id, f.trip.id, f.run.id);
  await expect(finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'succeeded' })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
}));

test.each(['unbound', 'missing', 'wrong-kind', 'reference', 'payload', 'matching'] as const)(
  'P3 awaiting requires a matching bound proposal answer: %s', kind => withDatabase(async () => {
    const f = await setup(), items = f.trip.snapshot.entries.map(entry => entry.item);
    const proposalId = await saveProposal(f.owner.id, f.trip.id, 1,
      buildProposal(f.trip.snapshot, [{ kind: 'remove', entryId: 'transfer' }], items, 'agent'), items);
    await startAnswerPhase(f.owner.id, f.trip.id, f.run.id);
    if (kind !== 'unbound') await bindProposal(f.owner.id, f.trip.id, f.run.id, proposalId, 'gate', 'proposal-call');
    if (kind === 'wrong-kind') await recordSimpleAnswer(f.owner.id, f.trip.id, f.run.id);
    else if (kind !== 'missing') {
      const event = await proposalAnswer(f.owner.id, f.trip.id, f.run.id, proposalId, kind === 'reference' ? 'foreign-tool' : 'proposal-call');
      if (kind === 'payload' && event.value.body.kind === 'proposal') event.value.body.changeCount += 1;
      if (kind === 'reference' || kind === 'payload' || kind === 'unbound') {
        await expect(appendRunEvent(f.owner.id, f.trip.id, f.run.id, event)).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
        expect((await getRun(f.owner.id, f.trip.id, f.run.id))?.events.some(item => item.event.type === EventType.CUSTOM)).toBe(false);
      } else await appendRunEvent(f.owner.id, f.trip.id, f.run.id, event);
    }
    await expect(finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'succeeded' })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
    const finish = () => finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'awaiting_confirmation' });
    if (kind === 'matching') expect((await finish()).status).toBe('awaiting_confirmation');
    else {
      await expect(finish()).rejects.toMatchObject({ code: kind === 'unbound' ? 'RUN_STATE_CONFLICT' : 'INVALID_RUN_EVENT' });
      expect((await getRun(f.owner.id, f.trip.id, f.run.id))?.status).toBe('running');
    }
  }));

test('P3 projection write failure consumes neither answerId nor sequence', () => withDatabase(async () => {
  const { owner, trip, run, event } = await setup();
  await database().query(`CREATE FUNCTION reject_answer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'projection unavailable'; END $$;
    CREATE TRIGGER reject_answer BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION reject_answer()`);
  await expect(appendRunEvent(owner.id, trip.id, run.id, event)).rejects.toThrow('projection unavailable');
  expect((await getRun(owner.id, trip.id, run.id))?.events).toEqual([]);
  await database().query('DROP TRIGGER reject_answer ON agent_run_events');
  expect((await appendRunEvent(owner.id, trip.id, run.id, event)).sequence).toBe(1);
}));

test('P3 persisted projection replay does not invoke compiler, model or current catalog after a template change', () => withDatabase(async () => {
  const { owner, trip, run, event } = await setup();
  const started = await startAnswerPhase(owner.id, trip.id, run.id);
  const saved = await appendRunEvent(owner.id, trip.id, run.id, event);
  await finishRun(owner.id, trip.id, run.id, { status: 'succeeded' });
  await restoreVersion(owner.id, { tripId: trip.id, targetVersion: 1, baseVersion: 1, requestId: 'newer-version' });
  vi.spyOn(compiler, 'compileAnswer').mockImplementation(() => { throw new Error('new template must not run'); });
  vi.spyOn(compiler, 'compileFailure').mockImplementation(() => { throw new Error('new template must not run'); });
  const fresh = makePool(testDatabaseUrl(), (await database().query('SELECT current_schema() AS name')).rows[0].name);
  try {
    expect(await withDatabasePool(fresh, () => getRun(owner.id, trip.id, run.id))).toMatchObject({ events: [started, saved] });
    const replay = await withDatabasePool(fresh, () => chatReplay(owner.id, trip.id, run.id));
    expect(await replay.text()).toBe([started, saved].map(item => `id: ${item.sequence}\ndata: ${JSON.stringify(item.event)}\n\n`).join(''));
  } finally { await fresh.end(); }
}));

test.each([true, false])('P3 committed=%s failure keeps decision-time receipt after newer versions and atomic finish', confirmed => withDatabase(async () => {
  const f = await decision(confirmed);
  const later = await restoreVersion(f.owner.id, { tripId: f.trip.id, targetVersion: 1,
    baseVersion: f.receipt.version, requestId: 'after-decision' });
  const saved = await finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'failed',
    event: { type: EventType.RUN_ERROR, message: 'raw provider secret payload' } });
  expect(answers(saved.events)).toHaveLength(1);
  expect(answers(saved.events)[0].body).toEqual({ kind: 'failure', reason: 'incomplete-run', committed: f.receipt });
  expect(saved.events.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
  expect(JSON.stringify(saved)).not.toContain('raw provider secret payload');
  expect(JSON.stringify((await database().query('SELECT event FROM agent_run_events WHERE run_id=$1', [f.run.id])).rows))
    .not.toContain('raw provider secret payload');
  vi.spyOn(compiler, 'compileFailure').mockImplementation(() => { throw new Error('must replay persisted answer'); });
  expect(await getRun(f.owner.id, f.trip.id, f.run.id)).toEqual(saved);
  expect((await getTrip(f.owner.id, f.trip.id))?.version).toBe(later.version);
  if (!confirmed) {
    expect((await database().query('SELECT rejection_version FROM proposals WHERE id=$1', [f.proposalId])).rows[0].rejection_version).toBe(1);
    expect((await database().query("SELECT * FROM mutation_receipts WHERE request_id=$1", [`agent:${f.run.id}`])).rowCount).toBe(0);
  }
}));

test.each([[true, 'interrupted'], [false, 'interrupted'], [true, 'failed'], [false, 'failed']] as const)(
  'P3 committed=%s status=%s before answer/ACK: concurrent refresh recovers once without reapplying', (confirmed, status) => withDatabase(async () => {
  const f = await decision(confirmed);
  const later = await restoreVersion(f.owner.id, { tripId: f.trip.id, targetVersion: 1,
    baseVersion: f.receipt.version, requestId: 'later' });
  const before = (await getRun(f.owner.id, f.trip.id, f.run.id))!.events;
  if (status === 'interrupted') await expire(f.run.id);
  else await database().query("UPDATE agent_runs SET status='failed',lease_expires_at=NULL WHERE id=$1", [f.run.id]);
  const recovered = await Promise.all(Array.from({ length: 6 }, () => getRun(f.owner.id, f.trip.id, f.run.id)));
  expect(recovered.every(run => run?.status === status)).toBe(true);
  const saved = recovered[0]!;
  expect(answers(saved.events)).toHaveLength(1);
  expect(answers(saved.events)[0].body).toMatchObject({ kind: 'failure', committed: f.receipt });
  expect(saved.events).toHaveLength(before.length + 2);
  expect(saved.events.slice(0, before.length)).toEqual(before);
  expect((await chatReplay(f.owner.id, f.trip.id, f.run.id)).status).toBe(200);
  expect((await getTrip(f.owner.id, f.trip.id))?.version).toBe(later.version);
  expect(await claimResume(f.owner.id, f.trip.id, f.run.id, 'gate', confirmed)).toMatchObject({ claimed: false });
  await expect(appendRunEvent(f.owner.id, f.trip.id, f.run.id, f.event)).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
  expect(await getRun(f.owner.id, f.trip.id, f.run.id)).toEqual(saved);
}));

test('P3 accepted receipt remains immutable when the later agent turn fails', () => withDatabase(async () => {
  const f = await decision(true);
  const binding = { ownerId: f.owner.id, tripId: f.trip.id, runId: f.run.id, baseVersion: 1 };
  const receipt = receiptEvidence(binding, 'native-decision', f.receipt);
  const value = compiler.compileAnswer({ version: '1', answer: { kind: 'receipt', evidenceRef: receipt.id } }, {
    binding, eventId: 'receipt-final', evidence: [receipt],
  });
  const first = await appendRunEvent(f.owner.id, f.trip.id, f.run.id, { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value });
  const failed = await finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'failed' });
  expect(failed.events.find(event => event.sequence === first.sequence)).toEqual(first);
  expect(answers(failed.events).map(answer => answer.body)).toEqual([
    { kind: 'receipt', status: 'applied', version: 2 },
    { kind: 'failure', reason: 'incomplete-run', committed: { status: 'applied', version: 2 } },
  ]);
  expect(await getRun(f.owner.id, f.trip.id, f.run.id)).toEqual(failed);
}));

test.each([true, false])('P3 HTTP committed=%s then agent failure emits durable failure plus committed receipt', confirmed => withDatabase(async () => {
  const f = await pending();
  vi.mocked(executeAgent).mockImplementationOnce(async input => {
    expect(input.tripId).toBe(f.trip.id);
    expect(input.input).toMatchObject({ kind: 'resume', committedResult: {
      status: confirmed ? 'applied' : 'rejected', version: confirmed ? 2 : 1,
    } });
    throw new Error('raw worker error must stay private');
  });
  const response = await chatAgent(new Request('http://127.0.0.1:4318/api/agent', { method: 'POST' }), f.owner.id, f.trip.id, {
    threadId: f.trip.id, runId: randomUUID(), messages: [], state: {}, tools: [], context: [], forwardedProps: { runId: f.run.id },
    resume: [{ interruptId: 'gate', status: 'resolved', payload: { confirmed } }],
  });
  const text = await response.text();
  const saved = await getRun(f.owner.id, f.trip.id, f.run.id);
  const answer = answers(saved!.events)[0];
  expect(saved?.status).toBe('failed');
  expect(answer.body).toEqual({ kind: 'failure', reason: 'incomplete-run', committed: {
    status: confirmed ? 'applied' : 'rejected', version: confirmed ? 2 : 1,
  } });
  expect(text).toContain(JSON.stringify(answer));
  expect(text).not.toContain('raw worker error must stay private');
  expect(text.indexOf(ANSWER_EVENT_NAME)).toBeLessThan(text.indexOf('RUN_ERROR'));
  expect((await database().query('SELECT * FROM trip_versions WHERE trip_id=$1', [f.trip.id])).rowCount).toBe(confirmed ? 2 : 1);
}));

test('P3 failure projection/status are atomic; saved decision survives failed finish and recovers on lease expiry', () => withDatabase(async () => {
  const f = await decision(true);
  const before = (await getRun(f.owner.id, f.trip.id, f.run.id))!.events;
  await database().query(`CREATE FUNCTION reject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'finish unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_failure BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION reject_failure()`);
  await expect(finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'failed' })).rejects.toThrow('finish unavailable');
  expect(await getRun(f.owner.id, f.trip.id, f.run.id)).toMatchObject({ status: 'running', events: before });
  expect((await getTrip(f.owner.id, f.trip.id))?.version).toBe(2);
  await expire(f.run.id);
  expect(answers((await getRun(f.owner.id, f.trip.id, f.run.id))!.events)[0].body)
    .toMatchObject({ kind: 'failure', committed: { status: 'applied', version: 2 } });
}));

test('P5 legacy rows stay untouched and cannot resume, write, replay or leak old raw events through GET', () => withDatabase(async () => {
  const f = await setup();
  await database().query(`UPDATE agent_runs SET answer_contract_version=0,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.run.id]);
  const raw = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'legacy', delta: 'legacy raw private output' };
  await database().query('INSERT INTO agent_run_events(run_id,sequence,event) VALUES ($1,1,$2)', [f.run.id, JSON.stringify(raw)]);
  const before = (await database().query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0];
  expect(await getRun(f.owner.id, f.trip.id, f.run.id)).toMatchObject({ answerContractVersion: 0, status: 'running', events: [] });
  expect((await listRuns(f.owner.id, f.trip.id))[0].events).toEqual([]);
  const response = await chatRuns(f.owner.id, f.trip.id);
  expect(await response.text()).not.toContain('legacy raw private output');
  await expect(chatReplay(f.owner.id, f.trip.id, f.run.id)).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  for (const action of [
    () => startRun(f.owner.id, f.trip.id, 'request', f.run.message, 1),
    () => claimResume(f.owner.id, f.trip.id, f.run.id, 'gate', false),
    () => bindProposal(f.owner.id, f.trip.id, f.run.id, randomUUID(), 'gate', 'proposal-call'),
    () => appendRunEvent(f.owner.id, f.trip.id, f.run.id, f.event),
    () => finishRun(f.owner.id, f.trip.id, f.run.id, { status: 'failed' }),
  ]) await expect(action()).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  expect((await database().query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0]).toEqual(before);
  expect((await database().query('SELECT event FROM agent_run_events WHERE run_id=$1', [f.run.id])).rows).toEqual([{ event: raw }]);
}));

test('P5 SQL default remains contract 0 and old pending decisions cannot reach version-store', () => withDatabase(async () => {
  const f = await setup();
  const items = f.trip.snapshot.entries.map(entry => entry.item);
  const proposalId = await saveProposal(f.owner.id, f.trip.id, 1,
    buildProposal(f.trip.snapshot, [{ kind: 'remove', entryId: 'transfer' }], items, 'agent'), items);
  await database().query('UPDATE agent_runs SET answer_contract_version=DEFAULT,proposal_id=$2,interrupt_id=$3,decision=true WHERE id=$1',
    [f.run.id, proposalId, 'gate']);
  expect((await database().query('SELECT answer_contract_version FROM agent_runs WHERE id=$1', [f.run.id])).rows[0].answer_contract_version).toBe(0);
  await expect(applyProposal(f.owner.id, { tripId: f.trip.id, proposalId, requestId: `agent:${f.run.id}`, baseVersion: 1 }, f.run.id))
    .rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await database().query('UPDATE agent_runs SET decision=false WHERE id=$1', [f.run.id]);
  await expect(rejectProposal(f.owner.id, f.trip.id, proposalId, f.run.id)).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  expect((await database().query('SELECT status,rejection_version FROM proposals WHERE id=$1', [proposalId])).rows[0])
    .toEqual({ status: 'pending', rejection_version: null });
}));
