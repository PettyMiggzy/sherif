import type { Metadata } from 'next';
import { AdminPanel } from '@/components/AdminPanel';
import { TreasuryPanel } from '@/components/TreasuryPanel';

// Not linked from anywhere. Anyone can collect fees into the treasury; only
// the treasury owner can withdraw, and only the pad admin can use the switch.
export const metadata: Metadata = { title: 'Pad admin', robots: { index: false, follow: false } };

export default function Admin() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <TreasuryPanel />
      <AdminPanel />
    </div>
  );
}
