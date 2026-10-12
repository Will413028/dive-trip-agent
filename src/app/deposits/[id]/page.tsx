import BookingView from '../../../features/deposits/BookingView';
import '../deposits.css';

export default async function DepositBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingView key={id} bookingId={id} />;
}
