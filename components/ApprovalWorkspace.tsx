'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PAYABLE_STATUSES, type BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { ApprovalDialog } from './ApprovalDialog';
import { BillGrid } from './BillGrid';
import { PaymentAssistant } from './PaymentAssistant';

type PlanMeta = { instruction: string; summary: string; ids: string[] };

const sameSet = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every((x) => a.has(x));

/** Owns the payment selection shared by the Payment Assistant, the grid and the approval dialog. */
export function ApprovalWorkspace({ bills, payPalReady }: { bills: BillWithDetails[]; payPalReady: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<PlanMeta | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [assistantKey, setAssistantKey] = useState(0);

  const chosen = useMemo(
    () => bills.filter((b) => selected.has(b.id) && PAYABLE_STATUSES.includes(b.status)),
    [bills, selected],
  );
  const total = chosen.reduce((s, b) => s + (b.amount_minor_units ?? 0), 0);
  // The plan travels with the approval only if the Owner did not change the selection.
  const linkedPlan = plan && sameSet(new Set(chosen.map((b) => b.id)), plan.ids) ? plan : null;

  const onReview = useCallback((ids: string[], meta: { instruction: string; summary: string }) => {
    setSelected(new Set(ids));
    setPlan({ ...meta, ids });
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const onPaid = useCallback((summary: string) => {
    setDialogOpen(false);
    setSelected(new Set());
    setPlan(null);
    setNotice(summary);
    setAssistantKey((k) => k + 1); // a paid plan is done: clear the assistant
    router.refresh();
  }, [router]);

  return (
    <div className="space-y-6">
      <PaymentAssistant key={assistantKey} payPalReady={payPalReady} onReview={onReview} />

      <section aria-labelledby="bills-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
          <h2 id="bills-heading" className="text-base font-semibold text-slate-900">Approval table</h2>
          <span className="text-sm text-slate-500">{bills.length} uploaded</span>
        </div>

        {notice && (
          <div className="flex items-start justify-between gap-3 border-b border-teal-100 bg-teal-50 px-5 py-2.5 text-sm text-teal-900" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-teal-700 hover:text-teal-900" aria-label="Dismiss">×</button>
          </div>
        )}

        <BillGrid bills={bills} payPalReady={payPalReady} selectedIds={selected} onSelectionChange={setSelected} />

        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
          {payPalReady ? (
            <>
              <span className="text-sm text-slate-600">
                {chosen.length === 0 ? 'Tick payable bills to pay them' : (
                  <>
                    {chosen.length} selected · <strong className="tabular-nums text-slate-900">{formatCurrency(total)}</strong>
                    {chosen.some((b) => b.status === 'flagged') && <span className="ml-1 text-red-700">(includes flagged bills)</span>}
                    {linkedPlan && <span className="ml-1 text-indigo-700">· from the assistant&apos;s plan</span>}
                  </>
                )}
              </span>
              <div className="flex items-center gap-3">
                {chosen.length > 0 && (
                  <button type="button" onClick={() => { setSelected(new Set()); setPlan(null); }} className="text-sm font-medium text-slate-600 hover:text-slate-900">
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  disabled={chosen.length === 0}
                  onClick={() => setDialogOpen(true)}
                  className="rounded-md bg-[#0070ba] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#005ea6] disabled:opacity-40"
                >
                  Approve &amp; pay {chosen.length ? formatCurrency(total) : ''}
                </button>
              </div>
            </>
          ) : (
            <span className="text-sm text-slate-500">PayPal is not configured, so payments are disabled.</span>
          )}
        </div>
      </section>

      {dialogOpen && chosen.length > 0 && (
        <ApprovalDialog
          bills={chosen}
          plan={linkedPlan ? { instruction: linkedPlan.instruction, summary: linkedPlan.summary } : undefined}
          onClose={closeDialog}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}
