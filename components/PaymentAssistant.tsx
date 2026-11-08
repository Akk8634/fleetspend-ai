'use client';

import { useState } from 'react';
import type { PaymentPlan } from '@/lib/assistant/planEngine';
import { formatCurrency } from '@/lib/money/formatCurrency';

type Result =
  | { kind: 'plan'; plan: PaymentPlan; chips: string[]; instruction: string }
  | { kind: 'clarify'; question: string; instruction: string };

const EXAMPLES = [
  'Pay all clean fuel bills from this week',
  'Pay everything under $300',
  'Pay all Apex Fuel bills, including flagged ones',
];

/**
 * AI Payment Assistant (approval-agent Requirements 2–4). Suggest-only: it turns an
 * instruction into a plan; the Owner reviews and approves in the approval dialog.
 */
export function PaymentAssistant({
  payPalReady,
  onReview,
}: {
  payPalReady: boolean;
  onReview: (billIds: string[], plan: { instruction: string; summary: string }) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(text: string) {
    const value = text.trim();
    if (value.length < 3 || loading) return;
    setInstruction(value);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/assistant/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'The assistant is not available right now.');
      setResult(data as Result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assistant is not available right now.');
    } finally {
      setLoading(false);
    }
  }

  const plan = result?.kind === 'plan' ? result.plan : null;

  return (
    <section aria-labelledby="assistant-heading" className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.36-6.36-1.41 1.41M8.05 15.95l-1.41 1.41m0-10.72 1.41 1.41m7.9 7.9 1.41 1.41M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="assistant-heading" className="text-base font-semibold text-slate-900">Payment Assistant</h2>
          <p className="text-sm text-slate-600">Tell it what to pay. The assistant only suggests — nothing is paid until you approve.</p>
        </div>
      </div>

      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); ask(instruction); }}
      >
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={300}
          placeholder="e.g. Pay all clean fuel bills from this week"
          aria-label="Payment instruction"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <button
          type="submit"
          disabled={loading || instruction.trim().length < 3}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? 'Thinking…' : 'Make a plan'}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" disabled={loading} onClick={() => ask(ex)}
            className="rounded-full bg-white px-2.5 py-1 text-xs text-indigo-700 ring-1 ring-inset ring-indigo-200 hover:bg-indigo-50 disabled:opacity-50">
            {ex}
          </button>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}

      {result?.kind === 'clarify' && (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-700 ring-1 ring-inset ring-slate-200" role="status">
          <strong>Assistant:</strong> {result.question}
        </p>
      )}

      {plan && result?.kind === 'plan' && (
        <div className="mt-4 rounded-lg bg-white p-4 ring-1 ring-inset ring-slate-200" role="status">
          <p className="text-sm text-slate-800"><strong>Plan:</strong> {plan.criteria.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {result.chips.map((c) => (
              <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{c}</span>
            ))}
          </div>

          {plan.included.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No bills match this instruction right now.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
              {plan.included.map((i) => (
                <li key={i.billId} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{i.vendor}</span>
                    {i.invoice && <span className="text-slate-500"> #{i.invoice}</span>}
                    <span className="block text-xs text-slate-500">{i.reason}</span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatCurrency(i.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}

          {plan.excluded.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-slate-600">Left out: {plan.excluded.length} bill{plan.excluded.length === 1 ? '' : 's'}</summary>
              <ul className="mt-1 space-y-1 pl-4 text-xs text-slate-600">
                {plan.excluded.map((e) => (
                  <li key={e.billId}><strong>{e.vendor}{e.invoice ? ` #${e.invoice}` : ''}</strong> ({formatCurrency(e.amountCents)}) — {e.reason}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-600">
              {plan.included.length} bill{plan.included.length === 1 ? '' : 's'} · {plan.payeeCount} payee{plan.payeeCount === 1 ? '' : 's'} ·{' '}
              <strong className="tabular-nums text-slate-900">{formatCurrency(plan.totalCents)}</strong>
            </span>
            <button
              type="button"
              disabled={!payPalReady || plan.included.length === 0}
              onClick={() => onReview(plan.included.map((i) => i.billId), { instruction: result.instruction, summary: plan.criteria.summary })}
              className="rounded-md bg-[#0070ba] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#005ea6] disabled:opacity-50"
            >
              Review &amp; approve
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
