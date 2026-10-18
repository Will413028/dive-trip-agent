'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { request } from '../../lib/api';
import { PAYPAL_TIMEOUT_MS, bookingUrl as base, depositError, diverUrl, joinGroup } from './api';
import EvidenceForm from './EvidenceForm';
import PayPalCheckout from './PayPalCheckout';
import SettlementCard from './SettlementCard';
import { depositState, timelineLabel, usd } from './format';
import type { Booking } from './types';

export default function BookingView({ bookingId }: { bookingId: string }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [view, setView] = useState<'organizer' | 'diver'>('organizer');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [joinName, setJoinName] = useState('');
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    request<{ paypalClientId: string | null }>('/api/deposits/config')
      .then((config) => setClientId(config.paypalClientId), () => setClientId(null));
  }, []);


  const load = useCallback(async () => {
    try { setBooking(await request<Booking>(base(bookingId))); }
    catch (e) { setError(depositError(e)); }
  }, [bookingId]);

  useEffect(() => { void load(); }, [load]);

  const checkedOut = useCallback(() => { setJoinName(''); setError(''); void load(); }, [load]);

  // The workflow assesses and executes in the background; poll for a while afterwards.
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => { void load(); }, 2000);
    const stop = setTimeout(() => setChecking(false), 30_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [checking, load]);

  async function act<T>(run: () => Promise<T>, poll = false): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setError('');
    try {
      const result = await run();
      if (result && typeof result === 'object' && 'divers' in result) setBooking(result as unknown as Booking);
      if (poll) setChecking(true);
      return true;
    } catch (e) { setError(depositError(e)); await load(); return false; }
    finally { setBusy(false); }
  }

  if (!booking) return <main id="main" lang="en" className="deposits"><p role="status">{error || 'Loading booking…'}</p>
    <Link href="/deposits">Back to workspace</Link></main>;

  const open = booking.settlements.some((s) => s.status === 'proposed' || s.status === 'approved');
  return <main id="main" lang="en" className="deposits">
    <p><Link href="/deposits">← Workspace</Link></p>
    <p className="banner" role="note">PayPal <strong>sandbox</strong> · synthetic data · no real money moves. Whether a boat goes out is always the operator&apos;s call; this is not a dive-safety judgment.</p>
    <header className="booking-head">
      <div><h1>{booking.title}</h1>
        <p className="muted">Starts {booking.startsOn} · {booking.tripDays} days · deposit {usd(booking.depositMinor)} per diver · refund policy v1: {booking.policy.rules.map((r) => `${r.cause} ${r.refundPercent}% per cancelled day`).join(', ')}</p></div>
      <div role="tablist" aria-label="View as" className="tabs">
        <button role="tab" aria-selected={view === 'organizer'} onClick={() => setView('organizer')}>Organizer</button>
        <button role="tab" aria-selected={view === 'diver'} onClick={() => setView('diver')}>Diver</button>
      </div>
    </header>
    {error && <p role="alert" className="error">{error}</p>}

    <section className="panel" aria-labelledby="divers-title">
      <h2 id="divers-title">Divers and deposits</h2>
      <ul className="divers">{booking.divers.map((d) => <li key={d.id}>
        <strong>{d.name}</strong>{d.seeded && <small> seeded</small>}<span>{depositState(d)}</span>
      </li>)}</ul>
      {view === 'diver' && <div className="join">
        <label htmlFor="join-name">Join this group (a display name, not your real name)</label>
        <input id="join-name" maxLength={60} value={joinName} onChange={(e) => setJoinName(e.target.value)} />
        <p className="muted">Your deposit of {usd(booking.depositMinor)} is a PayPal sandbox authorization: a hold, not a charge. Use the sandbox test Visa <strong>4012 8888 8888 1881</strong>, any future expiry and CVC, and made-up contact details (see <a href="https://developer.paypal.com/tools/sandbox/card-testing/" target="_blank" rel="noreferrer">PayPal card testing</a>). Never enter a real card.</p>
        {clientId && <PayPalCheckout clientId={clientId} bookingId={bookingId}
          name={joinName} onDone={checkedOut} onError={(message) => { setError(message); void load(); }} />}
        <details>
          <summary>Checkout not working? Use the server&apos;s sandbox test card</summary>
          <button disabled={busy || !joinName.trim()} onClick={() => void act(async () => {
            const diverId = await joinGroup(bookingId, joinName.trim());
            return request(`${diverUrl(bookingId, diverId)}/test-card-hold`, {}, undefined, PAYPAL_TIMEOUT_MS);
          }).then((ok) => { if (ok) setJoinName(''); })}>
            Place hold with the test card</button>
        </details>
      </div>}
    </section>

    {view === 'organizer' && <>
      <EvidenceForm tripDays={booking.tripDays} busy={busy}
        onNotice={(kind, body) => act(() => request(`${base(bookingId)}/evidence`, { kind, body }))}
        onStorm={(days) => void act(() => request(`${base(bookingId)}/simulate-storm`, { cancelledDays: days }))} />
      <section className="panel" aria-labelledby="check-title">
        <h2 id="check-title">Fast-forward</h2>
        <p className="muted">Runs the next scheduled check now: the agent reads the evidence, the server computes every amount, and the mandate decides whether the agent may execute.</p>
        <button className="primary" disabled={busy || checking || open || booking.evidence.length === 0}
          onClick={() => void act(() => request(`${base(bookingId)}/check`, {}), true)}>
          {checking ? 'Watching for results…' : 'Check evidence now'}</button>
        {open && <p className="muted">Decide the open proposal first.</p>}
        <p className="muted">Mandate: auto-execute up to {usd(booking.mandate.autoMaxPerDiverMinor)} per diver and {usd(booking.mandate.autoMaxPerBookingMinor)} per booking; causes {booking.mandate.allowedCauses.join(', ')}; until {booking.mandate.expiresOn}.</p>
      </section>
    </>}

    {booking.settlements.length > 0 && <section aria-labelledby="settlements-title">
      <h2 id="settlements-title">Settlements</h2>
      {[...booking.settlements].reverse().map((s) => <SettlementCard key={s.id} settlement={s} divers={booking.divers}
        evidence={booking.evidence} busy={busy}
        onDecide={view === 'organizer' ? (decision) => void act(() => request(`${base(bookingId)}/settlements/${encodeURIComponent(s.id)}`, { decision }), decision === 'approve') : undefined} />)}
    </section>}

    <section className="panel" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Audit timeline</h2>
      <ol className="timeline">{booking.timeline.map((t, i) => <li key={i}>
        <time dateTime={t.at}>{t.at.slice(11, 19)}</time> {timelineLabel(t)}
        {typeof t.detail.excerpt === 'string' && <q>{t.detail.excerpt}</q>}
      </li>)}</ol>
    </section>
  </main>;
}
