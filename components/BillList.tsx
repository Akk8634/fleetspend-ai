import { connection } from 'next/server';
import { createServerClient } from '@/lib/db/client';
import { listUserBills } from '@/lib/db/bills';
import type { BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { createSupabasePaymentStore } from '@/lib/payments/store';
import { getPayPalConfig } from '@/lib/paypal/config';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import { PaymentsPanel } from './PaymentsPanel';

function Summary({ bills }: { bills: BillWithDetails[] }) {
  const sum = (status: string) =>
    bills.filter((b) => b.status === status).reduce((s, b) => s + (b.amount_minor_units ?? 0), 0);
  const count = (status: string) => bills.filter((b) => b.status === status).length;

  const cards = [
    { label: 'Ready to pay', value: formatCurrency(sum('ready')), sub: `${count('ready')} bills passed every check`, tone: 'text-emerald-700' },
    { label: 'Flagged', value: String(count('flagged')), sub: `${formatCurrency(sum('flagged'))} held for a closer look`, tone: 'text-red-700' },
    { label: 'Needs review', value: String(count('needs_review')), sub: 'AI was unsure; please confirm', tone: 'text-amber-700' },
    { label: 'Paid', value: formatCurrency(sum('paid')), sub: `${count('paid')} bills paid via PayPal`, tone: 'text-teal-700' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">{c.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${c.tone}`}>{c.value}</p>
          <p className="mt-0.5 text-xs text-slate-400">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}

/** Server component: summary cards, the selectable bill list and recent payments. */
export async function BillList() {
  await connection(); // always fresh data, rendered at request time
  const supabase = createServerClient();
  const payPalReady = getPayPalConfig() !== null;
  const [bills, batches] = await Promise.all([
    listUserBills(supabase),
    createSupabasePaymentStore(supabase).listRecentBatches(10),
  ]);

  return (
    <div className="space-y-6">
      <Summary bills={bills} />
      <ApprovalWorkspace bills={bills} payPalReady={payPalReady} />
      <PaymentsPanel batches={batches} />
    </div>
  );
}

export function BillListSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading bills">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-200/60" />)}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-slate-200/60" />
    </div>
  );
}
