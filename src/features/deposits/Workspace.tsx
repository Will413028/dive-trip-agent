'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { request } from '../../lib/api';
import { PAYPAL_TIMEOUT_MS, depositError } from './api';
import { usd } from './format';
import type { Booking } from './types';

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

// A cross-border group: four seeded divers abroad, an operator in Anilao, USD deposits.
export function demoBooking() {
  const startsOn = inDays(3);
  return {
    title: 'Anilao boat dives, 3 days', startsOn, tripDays: 3, siteLat: 13.76, siteLon: 120.92,
    depositMinor: 10000,
    rules: [{ cause: 'weather', refundPercent: 100 }, { cause: 'operator', refundPercent: 100 }],
    mandate: {
      autoMaxPerDiverMinor: 5000, autoMaxPerBookingMinor: 25000,
      allowedActions: ['void', 'partial_capture', 'capture', 'refund'], allowedCauses: ['weather'], expiresOn: startsOn,
    },
    seedDivers: 4,
  };
}

/** Reset keeps a booking whose holds PayPal has not confirmed released. */
export function resetKept(kept: number): string {
  return `${kept === 1 ? 'One booking was' : `${kept} bookings were`} kept: PayPal has not confirmed its holds were released. The nightly reset retries; try again later.`;
}

export default function Workspace() {
  const router = useRouter();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    request<Booking[]>('/api/deposits/bookings').then(setBookings, (e) => setError(depositError(e)));
  }, []);

  async function run(step: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await step(); } catch (e) { setError(depositError(e)); } finally { setBusy(false); }
  }

  return <main id="main" lang="en" className="deposits">
    <p className="banner" role="note">PayPal <strong>sandbox</strong> · synthetic data · no real money moves.</p>
    <h1>Group dive deposits</h1>
    <p>A cross-border dive group pays deposits to an operator abroad as PayPal holds, not charges. When the weather turns, an AI agent reads the operator&apos;s notice and the alerts, cites them, and proposes who owes what. The server computes every amount from the refund policy; inside your mandate the agent executes, outside it the agent stops and asks you.</p>
    <ol className="steps">
      <li>Create the demo group: four divers abroad place their deposit holds.</li>
      <li>Switch to the Diver view and join with your own deposit hold.</li>
      <li>Paste the sample operator notice or simulate a storm, then press <em>Check evidence now</em>.</li>
    </ol>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button className="primary large" disabled={busy}
        onClick={() => void run(async () => {
          const booking = await request<Booking>('/api/deposits/bookings', demoBooking(), undefined, PAYPAL_TIMEOUT_MS);
          router.push(`/deposits/${encodeURIComponent(booking.id)}`);
        })}>{busy ? 'Placing sandbox holds…' : 'Create demo group'}</button>
      <button disabled={busy || !bookings?.length}
        onClick={() => void run(async () => {
          const { kept } = await request<{ deleted: number; kept: number }>('/api/deposits/reset', {}, undefined, PAYPAL_TIMEOUT_MS);
          setBookings(await request<Booking[]>('/api/deposits/bookings'));
          if (kept) setError(resetKept(kept));
        })}>
        Reset workspace</button>
    </div>
    <p className="muted">Your workspace is private to this browser. Reset releases its open holds and deletes its bookings.</p>
    <section aria-labelledby="bookings-title">
      <h2 id="bookings-title">Your bookings</h2>
      {bookings === null ? <p role="status">Loading…</p> : bookings.length === 0 ? <p className="muted">No bookings yet.</p>
        : <ul className="booking-list">{bookings.map((b) => <li key={b.id}>
          <Link href={`/deposits/${encodeURIComponent(b.id)}`}>{b.title}</Link>
          <span className="muted"> · starts {b.startsOn} · {b.divers.length} divers · {usd(b.depositMinor)} each</span>
        </li>)}</ul>}
    </section>
  </main>;
}
