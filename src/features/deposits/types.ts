// Wire shapes of /api/deposits (backend/src/dive_trip/bootstrap/deposits_api.py view()).
// Amounts are USD minor units computed by the server; the UI only formats them.

export type Cause = 'weather' | 'operator';
export type Action = 'void' | 'partial_capture' | 'capture' | 'refund' | 'none';

export interface Diver {
  id: string; name: string; seeded: boolean;
  state: 'pending' | 'authorized' | 'captured' | 'voided';
  authorizedMinor: number; capturedMinor: number; refundedMinor: number;
  authorizationId: string | null;
}

export interface Evidence { id: string; kind: 'notice' | 'alert' | 'forecast' | 'simulated'; body: string; createdAt: string }

export interface PlanItem { diverId: string; action: Action; amountMinor: number; owedMinor: number; returnedMinor: number }

export interface AgentCall {
  mode: 'live' | 'recorded' | 'capped';
  status: 'started' | 'succeeded' | 'failed';
  model: string | null;
  at: string;
  confidence: 'low' | 'medium' | 'high' | null;
  executionRequested: boolean | null;
  citations: { evidenceId: string; quote: string }[];
}

export interface Settlement {
  id: string;
  source: 'ai' | 'no_ai' | 'organizer';
  facts: { cause: Cause; cancelledDays: number[]; evidenceIds: string[] };
  plan: PlanItem[];
  withinMandate: boolean;
  reasons: string[];
  status: 'proposed' | 'approved' | 'rejected' | 'executed';
  agent: AgentCall | null;
}

export interface TimelineEntry { kind: string; detail: Record<string, unknown>; at: string }

export interface Booking {
  id: string; title: string; startsOn: string; tripDays: number;
  site: { lat: number; lon: number };
  depositMinor: number;
  policy: { rules: { cause: Cause; refundPercent: number }[] };
  mandate: {
    autoMaxPerDiverMinor: number; autoMaxPerBookingMinor: number;
    allowedActions: Action[]; allowedCauses: Cause[]; expiresOn: string;
  };
  divers: Diver[];
  evidence: Evidence[];
  settlements: Settlement[];
  timeline: TimelineEntry[];
}
