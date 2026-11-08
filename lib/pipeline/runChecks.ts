import { checkDuplicate, type ExistingBill, type Flag } from '../checks/checkDuplicate';
import { checkNewPayee } from '../checks/checkNewPayee';
import { checkOvercharge } from '../checks/checkOvercharge';
import { checkPolicyLimit } from '../checks/checkPolicyLimit';
import type { BillStatus } from '../db/types';
import type { PipelineStore } from './store';

export type ProcessResult = {
  billId: string;
  status: BillStatus;
  flags: Flag[];
  error?: string;
  lowConfidenceFields?: string[];
  skipped?: boolean;
};

/** Pure: run all four checks and return every flag that fired, in a fixed order. */
export function computeFlags(input: {
  bill: { id: string; vendor_id: string; invoice_number: string | null; amount_minor_units: number; bill_date: string };
  vendorName: string;
  existingBills: ExistingBill[];
  history: { count: number; sum: number };
  paidVendorIds: ReadonlySet<string>;
  policyLimit: number | null;
}): Flag[] {
  const { bill, vendorName } = input;
  return [
    checkDuplicate(bill, input.existingBills),
    checkOvercharge({ amount_minor_units: bill.amount_minor_units, vendor_name: vendorName }, input.history),
    checkNewPayee(bill.vendor_id, vendorName, input.paidVendorIds),
    checkPolicyLimit(bill.amount_minor_units, input.policyLimit),
  ].filter((f): f is Flag => f !== null);
}

export class IncompleteBillError extends Error {
  constructor(billId: string, missing: string[]) {
    super(`Bill ${billId} cannot be checked yet; missing ${missing.join(', ')}`);
    this.name = 'IncompleteBillError';
  }
}

/** Load check data, run the checks, and atomically store flags + ready/flagged status. */
export async function runChecksAndComplete(
  billId: string,
  store: PipelineStore,
  policyLimit: number | null,
): Promise<ProcessResult> {
  const bill = await store.getBill(billId);
  const missing = (['vendor_id', 'amount_minor_units', 'bill_date', 'currency_code'] as const).filter(
    (k) => bill[k] === null,
  );
  if (missing.length) throw new IncompleteBillError(billId, missing);

  const vendorId = bill.vendor_id!;
  const [existingBills, history, paidVendorIds] = await Promise.all([
    store.getBillsForDuplicateCheck(vendorId),
    store.getOverchargeHistory(vendorId, bill.currency_code!),
    store.getPaidVendorIds(),
  ]);

  const flags = computeFlags({
    bill: {
      id: bill.id,
      vendor_id: vendorId,
      invoice_number: bill.invoice_number,
      amount_minor_units: bill.amount_minor_units!,
      bill_date: bill.bill_date!,
    },
    vendorName: bill.vendor_name ?? bill.vendor_name_raw ?? 'this vendor',
    existingBills,
    history,
    paidVendorIds,
    policyLimit,
  });

  await store.completeChecks(billId, flags);
  return { billId, status: flags.length ? 'flagged' : 'ready', flags };
}
