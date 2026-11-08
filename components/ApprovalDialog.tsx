'use client';

import { useEffect, useRef, useState } from 'react';
import type { BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { CHECK_LABEL } from '@/lib/ui/labels';

type Problem = { bill_id: string | null; label: string; reason: string };

/**
 * Human-in-the-loop confirmation before any money moves: lists every payee and amount,
 * requires a typed reason for each flagged bill, and is safe against double clicks.
 */
export function ApprovalDialog({
  bills,
  plan,
  onClose,
  onPaid,
}: {
  bills: BillWithDetails[];
  /** Present when the selection is exactly the Payment Assistant's plan (stored for the audit trail). */
  plan?: { instruction: string; summary: string };
  onClose: () => void;
  onPaid: (summary: string) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const sendingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const total = bills.reduce((s, b) => s + (b.amount_minor_units ?? 0), 0);
  const payees = new Set(bills.map((b) => b.payee_email)).size;
  const flagged = bills.filter((b) => b.status === 'flagged');
  const missingReason = flagged.some((b) => !reasons[b.id]?.trim());

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sendingRef.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function pay() {
    if (sendingRef.current) return; // double-click guard
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setProblems([]);
    try {
      const res = await fetch('/api/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billIds: bills.map((b) => b.id),
          overrides: Object.fromEntries(flagged.map((b) => [b.id, reasons[b.id]?.trim() ?? ''])),
          ...(plan ? { plan } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblems(data.problems ?? []);
        setError(data.error ?? 'Payment could not be started.');
        return;
      }
      const batch = data.batch;
      const paid = batch.items.filter((i: { outcome: string }) => i.outcome === 'success').length;
      const failed = batch.items.filter((i: { outcome: string }) => i.outcome === 'failed').length;
      onPaid(
        batch.status === 'failed'
          ? `PayPal rejected the payment: ${batch.error_message ?? 'unknown error'}`
          : `Sent ${formatCurrency(batch.total_minor_units)} to PayPal · ${paid} paid${failed ? `, ${failed} failed` : ''}${
              batch.finished ? '' : ', the rest are still processing'
            }.`,
      );
    } catch {
      setError('Network error. Check the Payments section before trying again.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-title"
        tabIndex={-1}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none sm:rounded-2xl"
      >
        <h2 id="approve-title" className="text-lg font-semibold text-slate-900">Approve payment</h2>
        <p className="mt-1 text-sm text-slate-600">
          You are about to pay <strong>{formatCurrency(total)}</strong> to {payees} payee{payees === 1 ? '' : 's'} with PayPal (sandbox).
          The AI never pays on its own — this needs your confirmation.
        </p>
        {plan && (
          <p className="mt-2 rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
            Suggested by the Payment Assistant for “{plan.instruction}”. {plan.summary}
          </p>
        )}

        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {bills.map((b) => {
            const problem = problems.find((p) => p.bill_id === b.id);
            return (
              <li key={b.id} className="px-3 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{b.vendor_name ?? b.vendor_name_raw}</p>
                    <p className="truncate text-xs text-slate-500">
                      {b.invoice_number ? `#${b.invoice_number} · ` : ''}{b.payee_email ?? 'no PayPal email'}
                    </p>
                  </div>
                  <p className="font-semibold tabular-nums text-slate-900">{formatCurrency(b.amount_minor_units ?? 0)}</p>
                </div>

                {b.status === 'flagged' && (
                  <div className="mt-2 rounded-md bg-red-50 p-2.5">
                    <ul className="space-y-0.5 text-xs text-red-800">
                      {b.flags.map((f) => (
                        <li key={f.check_name}><strong>{CHECK_LABEL[f.check_name]}:</strong> {f.reason}</li>
                      ))}
                    </ul>
                    <label htmlFor={`reason-${b.id}`} className="mt-2 block text-xs font-medium text-slate-700">
                      Why is it OK to pay this anyway? (required)
                    </label>
                    <textarea
                      id={`reason-${b.id}`}
                      rows={2}
                      maxLength={500}
                      value={reasons[b.id] ?? ''}
                      onChange={(e) => setReasons((r) => ({ ...r, [b.id]: e.target.value }))}
                      placeholder="e.g. Called the vendor: fuel price went up this week"
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    />
                  </div>
                )}
                {b.status === 'payout_failed' && b.payout?.error_message && (
                  <p className="mt-1 text-xs text-rose-700">Last attempt failed: {b.payout.error_message}</p>
                )}
                {problem && <p className="mt-1 text-xs font-medium text-red-600" role="alert">{problem.reason}</p>}
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-600">Total</span>
          <span className="text-base font-semibold tabular-nums text-slate-900">{formatCurrency(total)}</span>
        </div>

        {error && <p className="mt-3 text-sm font-medium text-red-600" role="alert">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <button type="button" onClick={onClose} disabled={sending} className="text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={pay}
            disabled={sending || missingReason}
            className="rounded-md bg-[#0070ba] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#005ea6] disabled:opacity-50"
          >
            {sending ? 'Sending to PayPal…' : `Pay ${formatCurrency(total)} with PayPal`}
          </button>
        </div>
        {missingReason && <p className="mt-2 text-right text-xs text-slate-500">Type a reason for each flagged bill to continue.</p>}
      </div>
    </div>
  );
}
