import type { BillStatus, BillWithDetails } from '../db/types';
import { formatCurrency } from '../money/formatCurrency';
import { InvalidAmountError, parseAmountText } from '../money/parseAmountText';
import { CHECK_LABEL, formatDate } from '../ui/labels';
import { normalizeVendorName } from '../vendors/normalizeVendorName';
import type { PlanCriteria } from './criteriaSchema';

/** System-wide maximum for one assistant plan: $5,000.00. */
export const PLAN_CAP_CENTS = 500_000;

const PAYABLE: readonly BillStatus[] = ['ready', 'flagged', 'payout_failed'];
const CATEGORY_LABEL: Record<string, string> = {
  fuel: 'Fuel', repair: 'Repair', parts: 'Parts', driver_trip: 'Driver trip', other: 'Other',
};

export type PlanBill = Pick<
  BillWithDetails,
  'id' | 'status' | 'vendor_name' | 'invoice_number' | 'bill_date' | 'amount_minor_units' | 'category' | 'payee_email' | 'flags'
>;

export type PlanEntry = { billId: string; vendor: string; invoice: string | null; amountCents: number; reason: string };

export type PaymentPlan = {
  criteria: PlanCriteria;
  included: PlanEntry[];
  excluded: PlanEntry[];
  totalCents: number;
  payeeCount: number;
  limitCents: number;
};

const toCents = (text: string | null | undefined): number | null => {
  if (!text) return null;
  try {
    return parseAmountText(text, 'USD');
  } catch (err) {
    if (err instanceof InvalidAmountError) return null;
    throw err;
  }
};

const vendorMatches = (vendor: string, wanted: string[]) => {
  if (wanted.length === 0) return true;
  const v = normalizeVendorName(vendor);
  if (!v) return false;
  return wanted.some((w) => {
    const n = normalizeVendorName(w);
    return n.length > 0 && (v === n || v.includes(n) || n.includes(v));
  });
};

/** Plain-English chips describing the interpreted criteria. */
export function describeCriteria(c: PlanCriteria): string[] {
  const chips: string[] = [];
  if (c.vendor_names.length) chips.push(c.vendor_names.join(', '));
  if (c.categories.length) chips.push(c.categories.map((x) => CATEGORY_LABEL[x] ?? x).join(', '));
  if (c.date_from || c.date_to) {
    chips.push(c.date_from && c.date_to ? `${formatDate(c.date_from)} – ${formatDate(c.date_to)}`
      : c.date_from ? `From ${formatDate(c.date_from)}` : `Until ${formatDate(c.date_to!)}`);
  }
  const perBill = toCents(c.max_amount_per_bill);
  if (perBill) chips.push(`Each bill ≤ ${formatCurrency(perBill)}`);
  const total = toCents(c.max_total);
  if (total) chips.push(`Total ≤ ${formatCurrency(total)}`);
  chips.push(c.include_flagged ? 'Including flagged bills' : 'Clean bills only');
  if (c.include_failed) chips.push('Retry failed payments');
  return chips;
}

/**
 * Pure and deterministic: apply AI-produced criteria plus guardrails to the bills.
 * Only payable bills with an amount, date and payee email are ever included;
 * flagged / failed bills only when explicitly allowed; the total is capped.
 */
export function buildPlan(bills: readonly PlanBill[], criteria: PlanCriteria, opts: { planCapCents?: number } = {}): PaymentPlan {
  const cap = opts.planCapCents ?? PLAN_CAP_CENTS;
  const maxTotal = toCents(criteria.max_total);
  const limitCents = Math.min(maxTotal ?? Number.POSITIVE_INFINITY, cap);
  const perBill = toCents(criteria.max_amount_per_bill);

  const entry = (b: PlanBill, reason: string): PlanEntry => ({
    billId: b.id,
    vendor: b.vendor_name ?? 'Vendor',
    invoice: b.invoice_number,
    amountCents: b.amount_minor_units ?? 0,
    reason,
  });

  const matching = bills.filter(
    (b) =>
      PAYABLE.includes(b.status) &&
      b.amount_minor_units !== null && b.amount_minor_units > 0 &&
      b.bill_date !== null &&
      !!b.payee_email &&
      vendorMatches(b.vendor_name ?? '', criteria.vendor_names) &&
      (criteria.categories.length === 0 || (b.category !== null && (criteria.categories as string[]).includes(b.category))) &&
      (!criteria.date_from || b.bill_date >= criteria.date_from) &&
      (!criteria.date_to || b.bill_date <= criteria.date_to) &&
      (perBill === null || b.amount_minor_units <= perBill),
  );

  const excluded: PlanEntry[] = [];
  const allowed = matching.filter((b) => {
    if (b.status === 'flagged' && !criteria.include_flagged) {
      const what = b.flags.map((f) => CHECK_LABEL[f.check_name].toLowerCase()).join(', ') || 'needs attention';
      excluded.push(entry(b, `Flagged: ${what} — not included unless you ask for flagged bills`));
      return false;
    }
    if (b.status === 'payout_failed' && !criteria.include_failed) {
      excluded.push(entry(b, 'Previous payment failed — not retried unless you ask'));
      return false;
    }
    return true;
  });

  allowed.sort(
    (a, b) =>
      a.bill_date!.localeCompare(b.bill_date!) ||
      a.amount_minor_units! - b.amount_minor_units! ||
      a.id.localeCompare(b.id),
  );

  const included: PlanEntry[] = [];
  let total = 0;
  for (const b of allowed) {
    const amount = b.amount_minor_units!;
    if (total + amount > limitCents) {
      excluded.push(entry(b, `Would exceed the plan limit of ${formatCurrency(limitCents)}`));
      continue;
    }
    total += amount;
    const parts = [CATEGORY_LABEL[b.category ?? ''] ?? 'Bill', formatDate(b.bill_date).replace(/, \d{4}$/, '')];
    if (b.status === 'flagged') {
      parts.push(`flagged: ${b.flags.map((f) => CHECK_LABEL[f.check_name]).join(', ')} (you asked to include flagged bills)`);
    } else if (b.status === 'payout_failed') {
      parts.push('retrying a failed payment');
    } else {
      parts.push('passed all checks');
    }
    included.push(entry(b, parts.join(' · ')));
  }

  const payeeCount = new Set(bills.filter((b) => included.some((i) => i.billId === b.id)).map((b) => b.payee_email)).size;
  return {
    criteria,
    included,
    excluded,
    totalCents: total,
    payeeCount,
    limitCents: Number.isFinite(limitCents) ? limitCents : cap,
  };
}
