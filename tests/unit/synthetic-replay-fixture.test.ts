import { expect, test } from 'vitest';
import { createEvidenceReplay, parseAcceptedAnswers, parseReplayBundle } from '../../evals/replay-bundle';
import { createSyntheticReplayBundle, syntheticReplayModel, syntheticReplayScenarios } from '../support/synthetic-replay-fixture';

test.each(syntheticReplayScenarios)('%s replay fixture is deterministic v2 AcceptedAnswer data, not captured model evidence', scenario => {
  const bundle = createSyntheticReplayBundle(scenario);
  expect(bundle).toEqual(createSyntheticReplayBundle(scenario));
  expect(parseReplayBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  expect(bundle).toMatchObject({ schemaVersion: 2, model: syntheticReplayModel });
  const run = bundle.afterStart.runs.runs[0];
  expect(run.answerContractVersion).toBe(1);
  const answers = parseAcceptedAnswers([...bundle.startEvents, ...bundle.resumeEvents], run.id);
  expect(answers.map(answer => answer.body.kind)).toEqual(scenario === 'proposal' ? ['proposal', 'receipt'] : ['clarify']);
  expect([...bundle.startEvents, ...bundle.resumeEvents].some(event => event.type.startsWith('TEXT_MESSAGE'))).toBe(false);
  expect(bundle.afterStart.trip).toEqual(bundle.initial.trip);
  expect(JSON.stringify(bundle)).not.toMatch(/privateUsage|nativeToolCalls|ownerId|modelProse|rawEvent/);
  bundle.final.trip.version = 999;
  expect(createSyntheticReplayBundle(scenario).final.trip.version).toBe(scenario === 'proposal' ? 2 : 1);
});

test.each(syntheticReplayScenarios)('%s fixture refresh retains answers and permits only its fixed synthetic decision', scenario => {
  const bundle = createSyntheticReplayBundle(scenario), run = bundle.afterStart.runs.runs[0];
  const replay = createEvidenceReplay(bundle), path = `/api/trips/${run.tripId}`;
  const start = { threadId: run.tripId, runId: 'browser-start', state: {}, tools: [], context: [],
    messages: [{ id: 'browser-message', role: 'user', content: bundle.prompt }], forwardedProps: { baseVersion: 1 } };
  expect(replay.respond('POST', `${path}/agent`, start).sse).toContain('dive_trip.answer.v1');
  const refreshed = replay.respond('GET', `${path}/runs`);
  expect(refreshed.json).toMatchObject({ runs: [{ answerContractVersion: 1, id: run.id }] });
  expect(replay.respond('GET', `${path}/runs`)).toEqual(refreshed);
  const resume = { threadId: run.tripId, runId: 'browser-resume', state: {}, tools: [], context: [], messages: [],
    forwardedProps: { runId: run.id }, resume: [{ interruptId: run.interruptId ?? 'not-a-gate',
      status: 'resolved', payload: { confirmed: true } }] };
  if (scenario === 'proposal') {
    replay.respond('POST', `${path}/agent`, resume);
    expect(replay.respond('GET', path).json).toEqual(bundle.final.trip);
    expect(replay.posts).toBe(2);
  } else {
    expect(() => replay.respond('POST', `${path}/agent`, resume)).toThrow();
    expect(replay.respond('GET', path).json).toEqual(bundle.initial.trip);
    expect(replay.posts).toBe(1);
  }
  expect(() => replay.respond('POST', `${path}/agent`, start)).toThrow();
});
