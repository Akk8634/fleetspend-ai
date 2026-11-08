import type { Flag } from './types';

export type { Flag } from './types';

export type BillForCheck = {
  id: string;
  vendor_id: string;
  invoice_number: string | null;
  amount_minor_units: number;
  bill_date: string; // YYYY-MM-DD
};

export type ExistingBill = BillForCheck & {
  vendor_name: string; // for the flag reason
};

/**
 * Pure: flags a bill if an earlier bill from the same vendor has
 *   (A) the same invoice number, or
 *   (B) the same amount on the same date.
 * Never matches the bill against itself. At most one flag, pointing at the
 * earliest matching bill.
 */
export function checkDuplicate(bill: BillForCheck, existingBills: readonly ExistingBill[]): Flag | null {
  const matches = existingBills.filter((existing) => {
    if (existing.id === bill.id || existing.vendor_id !== bill.vendor_id) return false;
    const sameInvoice =
      existing.invoice_number !== null &&
      bill.invoice_number !== null &&
      existing.invoice_number === bill.invoice_number;
    const sameAmountAndDate =
      existing.amount_minor_units === bill.amount_minor_units && existing.bill_date === bill.bill_date;
    return sameInvoice || sameAmountAndDate;
  });

  if (matches.length === 0) return null;

  // Earliest by date; ties broken by id so the result is deterministic.
  const earliest = [...matches].sort(
    (a, b) => a.bill_date.localeCompare(b.bill_date) || a.id.localeCompare(b.id),
  )[0];

  const what = earliest.invoice_number ? `invoice ${earliest.invoice_number}` : 'a bill';
  return {
    check_name: 'duplicate',
    reason: `Possible duplicate of ${what} from ${earliest.vendor_name} on ${earliest.bill_date}.`,
  };
}
