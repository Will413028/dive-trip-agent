'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/api';

// The slice of the PayPal JS SDK this page uses.
interface PayPalButtons { render(container: HTMLElement): Promise<void>; close(): Promise<void>; isEligible(): boolean }
interface PayPalNamespace {
  FUNDING: { CARD: string };
  Buttons(options: {
    fundingSource?: string;
    style?: Record<string, string>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
  }): PayPalButtons;
}
declare global { interface Window { paypal?: PayPalNamespace } }

let sdk: Promise<PayPalNamespace> | null = null;

function loadSdk(clientId: string): Promise<PayPalNamespace> {
  sdk ??= new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'client-id': clientId, currency: 'USD', intent: 'authorize', components: 'buttons',
      'enable-funding': 'card', 'disable-funding': 'paylater,venmo', 'buyer-country': 'US',
    });
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?${params}`;
    script.async = true;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PAYPAL_SDK_MISSING')));
    script.onerror = () => { sdk = null; reject(new Error('PAYPAL_SDK_UNAVAILABLE')); };
    document.head.append(script);
  });
  return sdk;
}

/** The judge's own deposit: a guest card AUTHORIZE in PayPal's sandbox checkout. */
export default function PayPalCheckout({ clientId, checkoutUrl, authorizeUrl, name, onDone, onError }: {
  clientId: string;
  checkoutUrl: string;
  authorizeUrl: (diverId: string) => string;
  name: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef({ name, onDone, onError });
  latest.current = { name, onDone, onError };
  const [ready, setReady] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let buttons: PayPalButtons | null = null;
    let cancelled = false;
    // PayPal may call createOrder again (e.g. after a field fails validation): reuse
    // the order already started for this name instead of adding another diver.
    let started: { name: string; diverId: string; orderId: string } | null = null;
    loadSdk(clientId).then(async (paypal) => {
      if (cancelled || !container.current) return;
      buttons = paypal.Buttons({
        fundingSource: paypal.FUNDING.CARD,
        style: { layout: 'vertical', label: 'pay' },
        createOrder: async () => {
          const displayName = latest.current.name.trim();
          if (!displayName) throw new Error('NAME_REQUIRED');
          if (started?.name !== displayName) {
            started = { name: displayName, ...await request<{ diverId: string; orderId: string }>(checkoutUrl, { name: displayName }) };
          }
          return started.orderId;
        },
        onApprove: async ({ orderID }) => {
          const diverId = started?.diverId ?? '';
          started = null;  // a retry after a decline starts a fresh order
          try {
            await request(authorizeUrl(diverId), { orderId: orderID }, undefined, 60_000);
            latest.current.onDone();
          } catch (error) {
            latest.current.onError(error instanceof ApiError && error.code === 'PAYPAL_INSTRUMENT_DECLINED'
              ? 'The PayPal sandbox declined this card, so no hold was placed. Try again, or use the sandbox test card below.'
              : 'PayPal did not confirm the hold. Refresh in a moment, or use the sandbox test card below.');
          }
        },
        onCancel: () => latest.current.onError('Checkout cancelled; no hold was placed.'),
        onError: (error) => latest.current.onError(error instanceof Error && error.message === 'NAME_REQUIRED'
          ? 'Enter a display name first.' : 'PayPal checkout failed. You can retry, or use the sandbox test card below.'),
      });
      if (!buttons.isEligible()) { setReady('unavailable'); return; }
      await buttons.render(container.current);
      if (!cancelled) setReady('ready');
    }).catch(() => { if (!cancelled) setReady('unavailable'); });
    return () => { cancelled = true; void buttons?.close().catch(() => undefined); };
  }, [clientId, checkoutUrl, authorizeUrl]);

  return <div className="paypal-checkout">
    {ready === 'loading' && <p role="status" className="muted">Loading PayPal checkout…</p>}
    {ready === 'unavailable' && <p role="alert" className="muted">PayPal checkout is unavailable right now; use the sandbox test card below.</p>}
    <div ref={container} />
  </div>;
}
