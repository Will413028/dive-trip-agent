import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ApiError } from '../../src/lib/api';
import { depositError } from '../../src/features/deposits/api';
import EvidenceForm, { SAMPLE_NOTICE } from '../../src/features/deposits/EvidenceForm';
import { checkoutError } from '../../src/features/deposits/PayPalCheckout';
import { resetKept } from '../../src/features/deposits/Workspace';
import SettlementCard from '../../src/features/deposits/SettlementCard';
import { depositState, sourceLabel, timelineLabel, usd } from '../../src/features/deposits/format';
import type { Diver, Evidence, Settlement } from '../../src/features/deposits/types';

const diver = (state: Diver['state'], captured = 0, refunded = 0): Diver => ({
  id: 'd1', name: 'Aiko (Osaka)', seeded: true, state, authorizedMinor: 10000,
  capturedMinor: captured, refundedMinor: refunded, authorizationId: 'A-1',
});
const evidence: Evidence[] = [{ id: 'e1', kind: 'notice', body: SAMPLE_NOTICE, createdAt: '2026-11-18T10:00:00Z' }];
const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  id: 's1', source: 'ai', facts: { cause: 'weather', cancelledDays: [2], evidenceIds: ['e1'] },
  plan: [{ diverId: 'd1', action: 'partial_capture', amountMinor: 6667, owedMinor: 6667, returnedMinor: 3333 }],
  withinMandate: false, reasons: ['AI_AND_RULES_DISAGREE'], status: 'proposed',
  agent: { mode: 'live', status: 'succeeded', model: 'gemini-2.5-flash', at: '2026-11-18T10:01:00Z', confidence: 'high',
    executionRequested: true, citations: [{ evidenceId: 'e1', quote: 'all boats are cancelled on Day 2' }] },
  ...over,
});

test('deposit states describe holds, releases, charges and refunds', () => {
  expect(usd(6667)).toBe('USD 66.67');
  expect(depositState(diver('authorized'))).toBe('On hold, not charged · USD 100.00');
  expect(depositState(diver('voided'))).toBe('Hold released · charged USD 0.00');
  expect(depositState(diver('captured', 10000, 3333))).toBe('Charged USD 100.00, refunded USD 33.33 · net USD 66.67');
});

test('the evidence input warns that pasted text reaches a free AI model', () => {
  const html = renderToStaticMarkup(<EvidenceForm tripDays={3} busy={false} onNotice={async () => true} onStorm={() => {}} />);
  expect(html).toContain('Paste demo text only');
  expect(html).toContain('aria-describedby="evidence-warning"');
  expect(html).toContain('Use sample notice');
  expect(SAMPLE_NOTICE).toMatch(/^OPERATOR NOTICE \(demo\)/);
});

test('an AI settlement shows verified quotes, server amounts and why it needs approval', () => {
  const html = renderToStaticMarkup(<SettlementCard settlement={settlement()} divers={[diver('authorized')]}
    evidence={evidence} busy={false} onDecide={() => {}} />);
  expect(html).toContain('AI · gemini-2.5-flash');
  expect(html).toContain('all boats are cancelled on Day 2');
  expect(html).toContain('Partial final capture');
  expect(html).toContain('USD 33.33');
  expect(html).toContain('AI and rules disagree');
  expect(html).toContain('Approve and execute');
});

test('recorded and capped results are labelled as such', () => {
  const recorded = settlement({ agent: { ...settlement().agent!, mode: 'recorded' } });
  expect(sourceLabel(recorded)).toBe('Recorded AI result · gemini-2.5-flash · 2026-11-18 10:01 UTC');
  const capped = settlement({ source: 'no_ai', reasons: ['NO_AI_NEEDS_APPROVAL', 'AI_DAILY_CAP_REACHED'],
    agent: { ...settlement().agent!, mode: 'capped', status: 'failed', model: null, citations: [] } });
  const html = renderToStaticMarkup(<SettlementCard settlement={capped} divers={[diver('authorized')]}
    evidence={evidence} busy={false} />);
  expect(html).toContain('No AI · deterministic rules');
  expect(html).toContain('Daily AI limit reached');
  expect(html).not.toContain('Approve and execute');
});

test('a check that settles nothing says when the AI did not run', () => {
  const at = '2026-11-18T10:01:00Z';
  expect(timelineLabel({ kind: 'no_cancellation_found', detail: { agent: 'ran' }, at })).toBe('No cancellation found');
  expect(timelineLabel({ kind: 'no_cancellation_found', detail: { agent: 'AI_UNAVAILABLE' }, at }))
    .toBe('Nothing settled: AI models unavailable; the forecast rules found no cancellation');
  expect(timelineLabel({ kind: 'no_cancellation_found', detail: { agent: 'not_configured' }, at }))
    .toBe('Nothing settled: AI not run; the forecast rules found no cancellation');
  expect(timelineLabel({ kind: 'evidence_added', detail: {}, at })).toBe('Evidence added');
});

test('a business conflict is never reported as an outage', () => {
  expect(depositError(new ApiError(409, 'DEPOSIT_NAME_TAKEN'))).toContain('Pick another display name');
  expect(depositError(new ApiError(409, 'DEPOSIT_HOLD_IN_FLIGHT'))).toContain('still confirming');
  expect(depositError(new ApiError(409, 'DEPOSIT_ATTEMPT_CLOSED'))).toContain('replaced by a newer attempt');
  expect(depositError(new ApiError(500, 'INTERNAL_ERROR'))).toContain('on our side');
  expect(depositError(new ApiError(500, 'INTERNAL_ERROR'))).not.toContain('unavailable');
  expect(depositError(new ApiError(503, 'SERVICE_UNAVAILABLE'))).toContain('unavailable');
});

test('a card checkout the server refused says why', () => {
  expect(checkoutError(new ApiError(409, 'DEPOSIT_NAME_TAKEN'))).toContain('Pick another display name');
  expect(checkoutError(new Error('NAME_REQUIRED'))).toBe('Enter a display name first.');
  expect(checkoutError(new Error('zoid destroyed'))).toContain('PayPal checkout failed');
});

test('a reset that keeps a booking says why', () => {
  expect(resetKept(1)).toMatch(/^One booking was kept: PayPal has not confirmed/);
  expect(resetKept(2)).toMatch(/^2 bookings were kept/);
});
