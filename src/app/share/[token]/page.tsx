import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { backendShare, hostedShare } from '../../../server/backend';
import { hostedConfig } from '../../../server/hosted';
import PublicTripView from '../../../features/sharing/PublicTripView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '唯讀行程快照 · 潛旅筆記', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function SharedTrip({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!process.env.DIVE_BACKEND_ORIGIN) throw new Error('SERVICE_UNAVAILABLE');
  const config = hostedConfig();
  const trip = config ? await hostedShare(config, token, new Headers(await headers()))
    : await backendShare(process.env.DIVE_BACKEND_ORIGIN, token);
  if (!trip) notFound();
  return <main id="main" className="landing"><section className="panel">
    <p className="eyebrow">A SHARED SNAPSHOT</p><h1>唯讀行程快照</h1>
    <p>這是分享當時的固定內容，不會跟著原行程更新。持有連結者可讀；擁有者可以撤銷。</p>
    <PublicTripView trip={trip} />
  </section></main>;
}
