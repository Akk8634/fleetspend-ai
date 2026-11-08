import type { CheckName } from '../checks/types';
import type { BillStatus } from '../db/types';

export const STATUS_LABEL: Record<BillStatus, string> = {
  uploaded: 'Uploaded',
  extracted: 'Checking',
  needs_review: 'Needs review',
  ready: 'Ready to pay',
  flagged: 'Flagged',
  payout_pending: 'Paying…',
  paid: 'Paid',
  payout_failed: 'Payment failed',
};

export const CHECK_LABEL: Record<CheckName, string> = {
  duplicate: 'Duplicate',
  overcharge: 'Overcharge',
  new_payee: 'New payee',
  policy_limit: 'Over limit',
};

export const FIELD_LABEL: Record<string, string> = {
  vendor_name: 'Vendor',
  amount_text: 'Amount',
  currency_code: 'Currency',
  bill_date: 'Bill date',
  invoice_number: 'Invoice number',
  payee_email: 'Payee email',
};

/** "2026-11-05" -> "Nov 5, 2026" (UTC, so the date never shifts by time zone). */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) return '—';
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? isoDate
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
