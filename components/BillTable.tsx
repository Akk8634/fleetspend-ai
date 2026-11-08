'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PAYABLE_STATUSES, type BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { CHECK_LABEL, formatDate } from '@/lib/ui/labels';
import { ApprovalDialog } from './ApprovalDialog';
import { BillStatusBadge } from './BillStatusBadge';

function Details({ bill }: { bill: BillWithDetails }) {
  if (bill.status === 'needs_review') {
    return <p className="text-amber-800">{bill.review_message ?? 'Please check the extracted details.'}</p>;
  }
  if (bill.status === 'payout_pending') {
    return <p className="text-indigo-700">Sending with PayPal… {bill.payout?.transaction_status === 'UNCLAIMED' ? '(waiting for the receiver to claim it)' : ''}</p>;
  }
  if (bill.status === 'paid') {
    return (
      <p className="text-teal-700">
        Paid via PayPal{bill.payout?.transaction_id ? <> · <span className="font-mono text-xs">{bill.payout.transaction_id}</span></> : ''}
        {bill.payee_email ? <span className="block truncate text-xs text-slate-500">to {bill.payee_email}</span> : null}
      </p>
    );
  }
  if (bill.status === 'payout_failed') {
    return <p className="text-rose-700">Payment failed: {bill.payout?.error_message ?? 'PayPal could not complete it.'} Select it to try again.</p>;
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

/** Bill list with selection and the "Approve & pay" action (payment-workflow Requirement 1, 5). */
export function BillTable({ bills, payPalReady }: { bills: BillWithDetails[]; payPalReady: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const payable = useMemo(() => bills.filter((b) => PAYABLE_STATUSES.includes(b.status)), [bills]);
  // Drop selections that are no longer payable (e.g. after a refresh).
  const chosen = payable.filter((b) => selected.has(b.id));
  const total = chosen.reduce((s, b) => s + (b.amount_minor_units ?? 0), 0);
  const readyIds = payable.filter((b) => b.status === 'ready').map((b) => b.id);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const onPaid = useCallback((summary: string) => {
    setDialogOpen(false);
    setSelected(new Set());
    setNotice(summary);
    router.refresh();
  }, [router]);

  return (
    <section aria-labelledby="bills-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <h2 id="bills-heading" className="text-base font-semibold text-slate-900">Bills</h2>
        <div className="flex items-center gap-3 text-sm">
          {readyIds.length > 0 && payPalReady && (
            <button type="button" onClick={() => setSelected(new Set(readyIds))} className="font-medium text-indigo-600 hover:text-indigo-800">
              Select all ready ({readyIds.length})
            </button>
          )}
          <span className="text-slate-500">{bills.length} uploaded</span>
        </div>
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-3 border-b border-teal-100 bg-teal-50 px-5 py-2.5 text-sm text-teal-900" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-teal-700 hover:text-teal-900" aria-label="Dismiss">×</button>
        </div>
      )}

      {bills.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">No bills yet. Upload a few above, or try the sample bills.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {bills.map((b) => {
            const canSelect = payPalReady && PAYABLE_STATUSES.includes(b.status);
            return (
              <li
                key={b.id}
                className={`grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 py-4 text-sm md:grid-cols-[1.5rem_minmax(0,1.3fr)_7rem_minmax(0,2fr)_8.5rem] md:items-start md:gap-4 ${
                  selected.has(b.id) && canSelect ? 'bg-indigo-50/50' : ''
                }`}
              >
                <div className="pt-0.5">
                  {canSelect && (
                    <input
                      type="checkbox"
                      checked={selected.has(b.id)}
                      onChange={() => toggle(b.id)}
                      aria-label={`Select ${b.vendor_name ?? 'bill'} ${b.invoice_number ?? ''} for payment`}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{b.vendor_name ?? b.vendor_name_raw ?? b.original_filename}</p>
                  <p className="truncate text-xs text-slate-500">{b.invoice_number ? `#${b.invoice_number} · ` : ''}{formatDate(b.bill_date)}</p>
                </div>
                <p className="col-start-2 font-semibold tabular-nums text-slate-900 md:col-start-auto md:text-right">
                  {b.amount_minor_units !== null ? formatCurrency(b.amount_minor_units) : b.amount_text ? `$${b.amount_text}?` : '—'}
                </p>
                <div className="col-start-2 min-w-0 md:col-start-auto"><Details bill={b} /></div>
                <div className="col-start-2 flex items-center gap-2 md:col-start-auto md:justify-end">
                  <BillStatusBadge status={b.status} />
                  {b.status === 'needs_review' && (
                    <Link href={`/bills/${b.id}/review`} className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">
                      Review
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(chosen.length > 0 || (!payPalReady && payable.length > 0)) && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
          {payPalReady ? (
            <>
              <span className="text-sm text-slate-600">
                {chosen.length} selected · <strong className="tabular-nums text-slate-900">{formatCurrency(total)}</strong>
                {chosen.some((b) => b.status === 'flagged') && <span className="ml-1 text-red-700">(includes flagged bills)</span>}
              </span>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setSelected(new Set())} className="text-sm font-medium text-slate-600 hover:text-slate-900">Clear</button>
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="rounded-md bg-[#0070ba] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#005ea6]"
                >
                  Approve &amp; pay {formatCurrency(total)}
                </button>
              </div>
            </>
          ) : (
            <span className="text-sm text-slate-500">PayPal is not configured, so payments are disabled.</span>
          )}
        </div>
      )}

      {dialogOpen && chosen.length > 0 && <ApprovalDialog bills={chosen} onClose={closeDialog} onPaid={onPaid} />}
    </section>
  );
}
