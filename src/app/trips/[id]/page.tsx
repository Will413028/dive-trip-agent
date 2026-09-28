import Workbench from '../../../features/workbench/Workbench';

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workbench key={id} tripId={id} />;
}
