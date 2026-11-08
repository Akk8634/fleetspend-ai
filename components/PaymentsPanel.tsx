import type { PayoutBatchWithItems } from '@/lib/payments/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { PayoutPoller, RefreshBatchButton } from './PayoutPoller';

const BATCH_STATUS: Record<string, { label: string; tone: string }> = {
  submitting: { label: 'Sending to PayPal', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  pending: { label: 'Pending', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  processing: { label: 'Processing', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  success: { label: 'Completed', tone: 'bg-teal-50 text-teal-700 ring-teal-200' },
  failed: { label: 'Rejected', tone: 'bg-rose-100 text-rose-800 ring-rose-300' },
  denied: { label: 'Denied', tone: 'bg-rose-100 text-rose-800 ring-rose-300' },
  canceled: { label: 'Canceled', tone: 'bg-slate-100 text-slate-700 ring-slate-300' },
};

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Recent PayPal payout batches (payment-workflow Requirement 5.2). */
export function PaymentsPanel({ batches }: { batches: PayoutBatchWithItems[] }) {
  const unfinished = batches.filter((b) => !b.finished).map((b) => b.id);

  return (
    <section aria-labelledby="payments-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <h2 id="payments-heading" className="text-base font-semibold text-slate-900">Payments</h2>
        <PayoutPoller batchIds={unfinished} />
      </div>
      {batches.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-slate-500">No payments yet. Select ready bills above and approve them.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {batches.map((b) => {
            const paid = b.items.filter((i) => i.outcome === 'success').length;
            const failed = b.items.filter((i) => i.outcome === 'failed').length;
            // PayPal's batch status can lag behind its items; once every item is final, label from the items.
            const shown =
              b.finished && b.status !== 'failed'
                ? failed === 0 ? 'success' : paid === 0 ? 'failed' : 'partial'
                : b.status;
            const s =
              shown === 'partial'
                ? { label: 'Partly paid', tone: 'bg-amber-50 text-amber-800 ring-amber-300' }
                : BATCH_STATUS[shown] ?? { label: shown, tone: 'bg-slate-100 text-slate-700 ring-slate-300' };
            const payees = new Set(b.items.map((i) => i.receiver_email)).size;
            return (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {formatCurrency(b.total_minor_units)} to {payees} payee{payees === 1 ? '' : 's'}
                    <span className="ml-2 text-xs font-normal text-slate-500">{time(b.created_at)}</span>
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {b.paypal_batch_id ? <>PayPal batch <span className="font-mono">{b.paypal_batch_id}</span> · </> : null}
                    {paid}/{b.item_count} paid{failed ? ` · ${failed} failed` : ''}
                    {b.error_message ? ` · ${b.error_message}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {!b.finished && <RefreshBatchButton batchId={b.id} />}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.tone}`}>{s.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
