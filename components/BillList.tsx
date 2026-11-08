import Link from 'next/link';
import { connection } from 'next/server';
import { createServerClient } from '@/lib/db/client';
import { listUserBills } from '@/lib/db/bills';
import type { BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { CHECK_LABEL, formatDate } from '@/lib/ui/labels';
import { BillStatusBadge } from './BillStatusBadge';

function Summary({ bills }: { bills: BillWithDetails[] }) {
  const sum = (status: string) =>
    bills.filter((b) => b.status === status).reduce((s, b) => s + (b.amount_minor_units ?? 0), 0);
  const count = (status: string) => bills.filter((b) => b.status === status).length;

  const cards = [
    { label: 'Ready to pay', value: formatCurrency(sum('ready')), sub: `${count('ready')} bills passed every check`, tone: 'text-emerald-700' },
    { label: 'Flagged', value: String(count('flagged')), sub: `${formatCurrency(sum('flagged'))} held for a closer look`, tone: 'text-red-700' },
    { label: 'Needs review', value: String(count('needs_review')), sub: 'AI was unsure; please confirm', tone: 'text-amber-700' },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

function Reasons({ bill }: { bill: BillWithDetails }) {
  if (bill.status === 'needs_review') {
    return <p className="text-amber-800">{bill.review_message ?? 'Please check the extracted details.'}</p>;
  }
  if (bill.flags.length === 0) {
    return bill.status === 'ready' ? <p className="text-slate-400">All checks passed</p> : null;
  }
  return (
    <ul className="space-y-1">
      {bill.flags.map((f) => (
        <li key={f.check_name} className="text-slate-700">
          <span className="mr-1.5 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{CHECK_LABEL[f.check_name]}</span>
          {f.reason}
        </li>
      ))}
    </ul>
  );
}

/** Server component: summary cards and the list of uploaded (non-seed) bills. */
export async function BillList() {
  await connection(); // always fresh data, rendered at request time
  const bills = await listUserBills(createServerClient());

  return (
    <div className="space-y-6">
      <Summary bills={bills} />

      <section aria-labelledby="bills-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 id="bills-heading" className="text-base font-semibold text-slate-900">Bills</h2>
          <span className="text-sm text-slate-500">{bills.length} uploaded</span>
        </div>

        {bills.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            No bills yet. Upload a few above, or try the sample bills.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {bills.map((b) => (
              <li key={b.id} className="grid grid-cols-1 gap-2 px-5 py-4 text-sm md:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,2fr)_8.5rem] md:items-start md:gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{b.vendor_name ?? b.vendor_name_raw ?? b.original_filename}</p>
                  <p className="truncate text-xs text-slate-500">
                    {b.invoice_number ? `#${b.invoice_number} · ` : ''}{formatDate(b.bill_date)}
                  </p>
                </div>
                <p className="font-semibold tabular-nums text-slate-900 md:text-right">
                  {b.amount_minor_units !== null ? formatCurrency(b.amount_minor_units) : (b.amount_text ? `$${b.amount_text}?` : '—')}
                </p>
                <div className="min-w-0"><Reasons bill={b} /></div>
                <div className="flex items-center gap-2 md:justify-end">
                  <BillStatusBadge status={b.status} />
                  {b.status === 'needs_review' && (
                    <Link href={`/bills/${b.id}/review`} className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">
                      Review
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function BillListSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading bills">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-200/60" />)}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-slate-200/60" />
    </div>
  );
}
