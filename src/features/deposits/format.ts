import type { Action, AgentCall, Diver, Settlement, TimelineEntry } from './types';

export function usd(minor: number): string {
  return `USD ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function depositState(diver: Diver): string {
  if (diver.state === 'pending') return 'No hold yet (checkout not completed)';
  if (diver.state === 'authorized') return `On hold, not charged · ${usd(diver.authorizedMinor)}`;
  if (diver.state === 'voided') return 'Hold released · charged USD 0.00';
  const net = diver.capturedMinor - diver.refundedMinor;
  return diver.refundedMinor
    ? `Charged ${usd(diver.capturedMinor)}, refunded ${usd(diver.refundedMinor)} · net ${usd(net)}`
    : `Charged ${usd(diver.capturedMinor)}`;
}

export const ACTION_LABEL: Record<Action, string> = {
  void: 'Void hold', partial_capture: 'Partial final capture', capture: 'Full capture', refund: 'Refund', none: 'No change',
};

export const REASON_LABEL: Record<string, string> = {
  NO_AI_NEEDS_APPROVAL: 'Rules-only ("No AI") proposal always needs approval',
  AI_UNAVAILABLE: 'AI models unavailable',
  AI_DAILY_CAP_REACHED: 'Daily AI limit reached',
  AI_FOUND_NO_CANCELLATION: 'AI found no cancellation; rules did',
  AI_AND_RULES_DISAGREE: 'AI and rules disagree',
  AI_NOT_CONFIDENT: 'AI confidence below high',
  AI_REQUESTED_REVIEW: 'AI asked the organizer to review',
  MANDATE_EXPIRED: 'Mandate expired',
  CAUSE_NOT_ALLOWED: 'Cause outside the mandate',
  ACTION_NOT_ALLOWED: 'Action outside the mandate',
  PER_DIVER_CAP_EXCEEDED: 'Per-diver auto cap exceeded',
  PER_BOOKING_CAP_EXCEEDED: 'Per-booking auto cap exceeded',
};

export function sourceLabel(settlement: Settlement): string {
  const agent: AgentCall | null = settlement.agent;
  if (settlement.source === 'ai') {
    return agent?.mode === 'recorded'
      ? `Recorded AI result · ${agent.model ?? 'unknown model'} · ${new Date(agent.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : `AI · ${agent?.model ?? 'unknown model'}`;
  }
  if (settlement.source === 'no_ai') return 'No AI · deterministic rules';
  return 'Organizer';
}

export function timelineLabel(entry: TimelineEntry): string {
  const agent = entry.detail.agent;
  // Without the AI only the forecast rules ran, so "nothing found" must not read as "no cancellation".
  if (entry.kind === 'no_cancellation_found' && typeof agent === 'string' && agent !== 'ran') {
    return `Nothing settled: ${REASON_LABEL[agent] ?? 'AI not run'}; the forecast rules found no cancellation`;
  }
  return entry.kind.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}
