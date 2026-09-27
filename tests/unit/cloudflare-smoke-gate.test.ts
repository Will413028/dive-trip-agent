import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { allowedSmokeRequest, cloudflareSmokePrompt } from '../support/cloudflare-smoke-gate';

const tripId = randomUUID(), confirmation = { runId: randomUUID(), interruptId: 'gate-1' };
const common = { threadId: tripId, runId: randomUUID(), tools: [], context: [], state: {} };
const start = { ...common, messages: [{ id: randomUUID(), role: 'user', content: cloudflareSmokePrompt }], forwardedProps: { baseVersion: 1 } };
const resume = { ...common, messages: [], forwardedProps: { runId: confirmation.runId },
  resume: [{ interruptId: confirmation.interruptId, status: 'resolved', payload: { confirmed: true } }] };
test('only one exact start and the verified confirmation can dispatch', () => {
  expect(allowedSmokeRequest(start, tripId, 0, 'proposal')).toBe(true);
  expect(allowedSmokeRequest(resume, tripId, 1, 'confirmation', confirmation)).toBe(true);
});
test('blocks fresh starts, replay, unrelated run/interrupt, wrong phase and altered input', () => {
  for (const body of [start, { ...resume, forwardedProps: { runId: randomUUID() } },
    { ...resume, resume: [{ ...resume.resume[0], interruptId: 'different' }] },
    { ...resume, resume: [{ ...resume.resume[0], payload: { confirmed: false } }] },
    { ...resume, threadId: randomUUID() }]) {
    expect(allowedSmokeRequest(body, tripId, 1, 'confirmation', confirmation)).toBe(false);
  }
  expect(allowedSmokeRequest(resume, tripId, 2, 'confirmation', confirmation)).toBe(false);
  expect(allowedSmokeRequest(resume, tripId, 1, 'proposal', confirmation)).toBe(false);
  expect(allowedSmokeRequest(resume, tripId, 1, 'confirmation')).toBe(false);
  expect(allowedSmokeRequest({ ...start, messages: [{ ...start.messages[0], content: 'different' }] }, tripId, 0, 'proposal')).toBe(false);
});
