import type { Metadata } from 'next';
import Workspace from '../../features/deposits/Workspace';
import './deposits.css';

export const metadata: Metadata = { title: 'Group dive deposits · PayPal sandbox demo' };

export default function DepositsPage() {
  return <Workspace />;
}
