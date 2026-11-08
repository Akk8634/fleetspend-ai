'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { parseAmountText } from '@/lib/money/parseAmountText';
import { FIELD_LABEL } from '@/lib/ui/labels';

export type ReviewBill = {
  id: string;
  vendor_id: string | null;
  vendor_name_raw: string | null;
  amount_text: string | null;
  currency_code: string | null;
  bill_date: string | null;
  invoice_number: string | null;
  payee_email: string | null;
  low_confidence_fields: string[] | null;
  review_message: string | null;
};

export type ReviewVendor = { id: string; name: string; paypal_email: string | null };

const NEW_VENDOR = '__new__';

function Field({
  id, label, unsure, error, hint, children,
}: { id: string; label: string; unsure?: boolean; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        {label}
        {unsure && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M8.5 2.6a1.7 1.7 0 0 1 3 0l6.3 11.4A1.7 1.7 0 0 1 16.3 16.5H3.7a1.7 1.7 0 0 1-1.5-2.5L8.5 2.6ZM10 7a.8.8 0 0 0-.8.8v3.4a.8.8 0 0 0 1.6 0V7.8A.8.8 0 0 0 10 7Zm0 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
            </svg>
            AI unsure
          </span>
        )}
      </label>
      <div className="mt-1">{children}</div>
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-1 text-xs font-medium text-red-600" role="alert">{error}</p>}
    </div>
  );
}

const inputClass = (unsure?: boolean, error?: string) =>
  `block w-full rounded-md border px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 ${
    error ? 'border-red-400 focus:ring-red-200' : unsure ? 'border-amber-400 bg-amber-50/50 focus:ring-amber-200' : 'border-slate-300 focus:ring-indigo-200'
  }`;

export function BillReviewForm({ bill, vendors }: { bill: ReviewBill; vendors: ReviewVendor[] }) {
  const router = useRouter();
  const unsure = new Set(bill.low_confidence_fields ?? []);

  const [vendorChoice, setVendorChoice] = useState(bill.vendor_id ?? NEW_VENDOR);
  const [vendorName, setVendorName] = useState(bill.vendor_name_raw ?? '');
  const [amount, setAmount] = useState(bill.amount_text ?? '');
  const [currency, setCurrency] = useState(bill.currency_code ?? 'USD');
  const [billDate, setBillDate] = useState(bill.bill_date ?? '');
  const [invoice, setInvoice] = useState(bill.invoice_number ?? '');
  const [email, setEmail] = useState(bill.payee_email ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pickedVendor = vendors.find((v) => v.id === vendorChoice);
  const amountPreview = useMemo(() => {
    try { return formatCurrency(parseAmountText(amount, 'USD')); } catch { return null; }
  }, [amount]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const res = await fetch(`/api/bills/${bill.id}/correct`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_id: pickedVendor?.id ?? null,
          vendor_name: pickedVendor ? pickedVendor.name : vendorName,
          amount,
          currency_code: currency,
          bill_date: billDate,
          invoice_number: invoice,
          payee_email: email,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        setFormError(data.fieldErrors ? 'Please fix the highlighted fields.' : (data.error ?? 'Could not save the corrections.'));
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setFormError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {bill.review_message && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Why this bill needs review</p>
          <p className="mt-0.5">{bill.review_message}</p>
        </div>
      )}

      <Field id="vendor" label={FIELD_LABEL.vendor_name} unsure={unsure.has('vendor_name')} error={errors.vendor_id ?? (pickedVendor ? errors.vendor_name : undefined)}>
        <select id="vendor" value={vendorChoice} onChange={(e) => setVendorChoice(e.target.value)} className={inputClass(unsure.has('vendor_name'), errors.vendor_id)}>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          <option value={NEW_VENDOR}>+ New vendor…</option>
        </select>
      </Field>

      {!pickedVendor && (
        <Field id="vendor_name" label="New vendor name" error={errors.vendor_name} hint={bill.vendor_name_raw ? `AI read: “${bill.vendor_name_raw}”` : undefined}>
          <input id="vendor_name" value={vendorName} onChange={(e) => setVendorName(e.target.value)} className={inputClass(false, errors.vendor_name)} autoComplete="off" />
        </Field>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="amount" label="Total amount" unsure={unsure.has('amount_text')} error={errors.amount}
          hint={amountPreview ? `Will be saved as ${amountPreview}` : 'e.g. 125.50'}>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-400">$</span>
            <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass(unsure.has('amount_text'), errors.amount)} pl-7 tabular-nums`} autoComplete="off" />
          </div>
        </Field>
        <Field id="currency" label={FIELD_LABEL.currency_code} unsure={unsure.has('currency_code')} error={errors.currency_code} hint="Only USD is supported">
          <input id="currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className={inputClass(unsure.has('currency_code'), errors.currency_code)} />
        </Field>
        <Field id="bill_date" label={FIELD_LABEL.bill_date} unsure={unsure.has('bill_date')} error={errors.bill_date}>
          <input id="bill_date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={inputClass(unsure.has('bill_date'), errors.bill_date)} />
        </Field>
        <Field id="invoice" label={FIELD_LABEL.invoice_number} error={errors.invoice_number} hint="Optional">
          <input id="invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} className={inputClass(false, errors.invoice_number)} autoComplete="off" />
        </Field>
      </div>

      <Field id="email" label="Payee PayPal email" error={errors.payee_email}
        hint={pickedVendor?.paypal_email && !email ? `Leave empty to use ${pickedVendor.paypal_email}` : 'Optional'}>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass(false, errors.payee_email)} autoComplete="off" />
      </Field>

      {formError && <p className="text-sm font-medium text-red-600" role="alert">{formError}</p>}

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button type="submit" disabled={saving} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50">
          {saving ? 'Saving & re-checking…' : 'Save and run checks'}
        </button>
        <button type="button" onClick={() => router.push('/')} className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </button>
      </div>
    </form>
  );
}
