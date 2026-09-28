import DeletionStatus from '../../../../features/workbench/DeletionStatus';

export default async function DeletionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeletionStatus key={id} tripId={id} />;
}
