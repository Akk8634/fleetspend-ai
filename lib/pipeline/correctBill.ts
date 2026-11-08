import { z } from 'zod';
import { InvalidAmountError, parseAmountText } from '../money/parseAmountText';
import { normalizeVendorName } from '../vendors/normalizeVendorName';
import { USD_ONLY_MESSAGE } from './processBill';
import { runChecksAndComplete, type ProcessResult } from './runChecks';
import type { Corrections, PipelineStore } from './store';

export const DEMO_ACTOR = 'demo_owner';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const isCalendarDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** What the review form submits. The owner types the amount as a normal decimal ("125.50"). */
export const correctionSchema = z.object({
  vendor_name: z.string().trim().min(1, 'Vendor name is required').max(255, 'Vendor name is too long'),
  vendor_id: z.preprocess(emptyToNull, z.uuid('Unknown vendor').nullish()),
  currency_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code')
    .refine((c) => c === 'USD', USD_ONLY_MESSAGE),
  amount: z.string().trim().min(1, 'Amount is required'),
  bill_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
    .refine(isCalendarDate, 'This is not a real date'),
  invoice_number: z.preprocess(emptyToNull, z.string().trim().max(100).nullish()),
  payee_email: z.preprocess(emptyToNull, z.email('Enter a valid email').nullish()),
});

export type CorrectionInput = z.input<typeof correctionSchema>;

export class CorrectionValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super(`Please fix: ${Object.keys(fieldErrors).join(', ')}`);
    this.name = 'CorrectionValidationError';
  }
}

export class BillNotReviewableError extends Error {
  constructor(public readonly status: string) {
    super(`Only bills that need review can be corrected (this bill is ${status}).`);
    this.name = 'BillNotReviewableError';
  }
}

/** Validate the form; returns clean values or throws CorrectionValidationError with one message per field. */
export function validateCorrection(input: unknown) {
  const parsed = correctionSchema.safeParse(input);
  const fieldErrors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      fieldErrors[field] ??= issue.message;
    }
  }

  let cents: number | null = null;
  const rawAmount = (input as { amount?: unknown } | null)?.amount;
  if (typeof rawAmount === 'string' && rawAmount.trim() && !fieldErrors.amount) {
    try {
      cents = parseAmountText(rawAmount, 'USD');
    } catch (err) {
      if (!(err instanceof InvalidAmountError)) throw err;
      fieldErrors.amount = 'Enter a positive amount with at most 2 decimals, e.g. 125.50 (max 9,999,999.99)';
    }
  }

  if (Object.keys(fieldErrors).length || !parsed.success || cents === null) {
    throw new CorrectionValidationError(Object.keys(fieldErrors).length ? fieldErrors : { form: 'Invalid input' });
  }
  return { ...parsed.data, cents };
}

/**
 * Apply the owner's corrections to a needs_review bill, then run the checks.
 * Validation happens before anything is written (Requirement 4.4).
 */
export async function correctBill(
  billId: string,
  input: unknown,
  deps: { store: PipelineStore; policyLimit: number | null },
): Promise<ProcessResult> {
  const { store, policyLimit } = deps;
  const values = validateCorrection(input);

  const bill = await store.getBill(billId);
  if (bill.status !== 'needs_review') throw new BillNotReviewableError(bill.status);

  // Resolve the vendor: an explicitly picked one must exist; otherwise match or create by name.
  let vendorId: string;
  if (values.vendor_id) {
    const picked = await store.getVendor(values.vendor_id);
    if (!picked) throw new CorrectionValidationError({ vendor_id: 'Unknown vendor' });
    vendorId = picked.id;
  } else {
    if (!normalizeVendorName(values.vendor_name)) {
      throw new CorrectionValidationError({ vendor_name: 'Vendor name must contain letters or numbers' });
    }
    vendorId = (await store.matchOrCreateVendor(values.vendor_name)).vendorId;
  }

  const vendor = await store.getVendor(vendorId);
  if (values.payee_email && !vendor?.paypal_email) {
    await store.setVendorEmailIfMissing(vendorId, values.payee_email);
  }
  const payeeEmail = values.payee_email ?? vendor?.paypal_email ?? null;

  const corrections: Corrections = {
    vendor_name_raw: values.vendor_name,
    vendor_id: vendorId,
    amount_text: values.amount.replace(/^\$\s*/, ''),
    amount_minor_units: values.cents,
    currency_code: values.currency_code,
    bill_date: values.bill_date,
    ...(values.invoice_number ? { invoice_number: values.invoice_number } : {}),
    ...(payeeEmail ? { payee_email: payeeEmail } : {}),
  };

  await store.saveCorrections(billId, corrections, DEMO_ACTOR);
  return runChecksAndComplete(billId, store, policyLimit);
}
