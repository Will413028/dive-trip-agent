import type { Metadata } from 'next';
import BookingView from '../../../features/deposits/BookingView';
import '../deposits.css';

export const metadata: Metadata = { title: 'Group deposit booking · PayPal sandbox demo' };

export default async function DepositBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingView key={id} bookingId={id} />;
}
