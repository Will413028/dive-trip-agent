'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/api';
import { PAYPAL_TIMEOUT_MS, depositError, diverUrl, joinGroup } from './api';

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
export default function PayPalCheckout({ clientId, bookingId, name, onDone, onError }: {
  clientId: string;
  bookingId: string;
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
    // The diver whose hold the current order is for. PayPal may call createOrder again
    // (e.g. after a field fails validation); the server then replaces the unfinished order.
    let diverId = '';
    // PayPal may hand onError its own error instead of ours, so keep what the server said.
    let refused: unknown = null;
    loadSdk(clientId).then(async (paypal) => {
      if (cancelled || !container.current) return;
      buttons = paypal.Buttons({
        fundingSource: paypal.FUNDING.CARD,
        style: { layout: 'vertical', label: 'pay' },
        createOrder: async () => {
          const displayName = latest.current.name.trim();
          if (!displayName) throw new Error('NAME_REQUIRED');
          refused = null;
          try {
            diverId = await joinGroup(bookingId, displayName);
            const { orderId } = await request<{ orderId: string }>(`${diverUrl(bookingId, diverId)}/checkout`, {});
            return orderId;
          } catch (error) { refused = error; throw error; }
        },
        onApprove: async ({ orderID }) => {
          try {
            await request(`${diverUrl(bookingId, diverId)}/authorize`, { orderId: orderID }, undefined, PAYPAL_TIMEOUT_MS);
            latest.current.onDone();
          } catch (error) {
            latest.current.onError(error instanceof ApiError && error.status === 503
              ? 'PayPal did not confirm the hold. Refresh in a moment, or use the sandbox test card below.'
              : depositError(error));
          }
        },
        onCancel: () => latest.current.onError('Checkout cancelled; no hold was placed.'),
        onError: (error) => latest.current.onError(checkoutError(refused ?? error)),
      });
      if (!buttons.isEligible()) { setReady('unavailable'); return; }
      await buttons.render(container.current);
      if (!cancelled) setReady('ready');
    }).catch(() => { if (!cancelled) setReady('unavailable'); });
    return () => { cancelled = true; void buttons?.close().catch(() => undefined); };
  }, [clientId, bookingId]);

  return <div className="paypal-checkout">
    {ready === 'loading' && <p role="status" className="muted">Loading PayPal checkout…</p>}
    {ready === 'unavailable' && <p role="alert" className="muted">PayPal checkout is unavailable right now; use the sandbox test card below.</p>}
    <div ref={container} />
  </div>;
}

/** PayPal reports createOrder failures through onError; say what our server refused. */
export function checkoutError(error: unknown): string {
  if (error instanceof ApiError) return depositError(error);
  if (error instanceof Error && error.message === 'NAME_REQUIRED') return 'Enter a display name first.';
  return 'PayPal checkout failed. You can retry, or use the sandbox test card below.';
}
