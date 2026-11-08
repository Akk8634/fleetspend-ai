import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExistingBill } from '../checks/checkDuplicate';
import type { Bill, BillWithDetails } from './types';

const BILL_WITH_DETAILS = '*, vendors(name), flags(check_name, reason)';

type BillRow = Bill & {
  vendors: { name: string } | null;
  flags: { check_name: BillWithDetails['flags'][number]['check_name']; reason: string }[] | null;
};

function toDetails(row: BillRow): BillWithDetails {
  const { vendors, flags, ...bill } = row;
  return { ...bill, vendor_name: vendors?.name ?? bill.vendor_name_raw, flags: flags ?? [] };
}

export class BillNotFoundError extends Error {
  constructor(id: string) {
    super(`Bill ${id} not found`);
    this.name = 'BillNotFoundError';
  }
}

export async function getBillById(id: string, supabase: SupabaseClient): Promise<BillWithDetails> {
  const { data, error } = await supabase.from('bills').select(BILL_WITH_DETAILS).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load bill: ${error.message}`);
  if (!data) throw new BillNotFoundError(id);
  return toDetails(data as BillRow);
}

/** Bills uploaded by the user (not seed history), newest first. */
export async function listUserBills(supabase: SupabaseClient): Promise<BillWithDetails[]> {
  const { data, error } = await supabase
    .from('bills')
    .select(BILL_WITH_DETAILS)
    .eq('is_seed', false)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load bills: ${error.message}`);
  return (data as BillRow[]).map(toDetails);
}

/** Bills from the same vendor that can count as an earlier copy (excludes unprocessed ones). */
export async function getBillsForDuplicateCheck(vendorId: string, supabase: SupabaseClient): Promise<ExistingBill[]> {
  const { data, error } = await supabase
    .from('bills')
    .select('id, vendor_id, invoice_number, amount_minor_units, bill_date, vendors(name)')
    .eq('vendor_id', vendorId)
    .not('status', 'in', '(uploaded,needs_review)')
    .not('amount_minor_units', 'is', null)
    .not('bill_date', 'is', null);
  if (error) throw new Error(`Could not load bills for duplicate check: ${error.message}`);

  type Row = {
    id: string; vendor_id: string; invoice_number: string | null;
    amount_minor_units: number; bill_date: string; vendors: { name: string } | null;
  };
  return (data as unknown as Row[]).map((r) => ({
    id: r.id,
    vendor_id: r.vendor_id,
    invoice_number: r.invoice_number,
    amount_minor_units: r.amount_minor_units,
    bill_date: r.bill_date,
    vendor_name: r.vendors?.name ?? 'this vendor',
  }));
}

/** Count and sum of PAID bills for a vendor in one currency (via RPC: REST aggregates are off). */
export async function getOverchargeHistory(
  vendorId: string,
  currencyCode: string,
  supabase: SupabaseClient,
): Promise<{ count: number; sum: number }> {
  const { data, error } = await supabase.rpc('get_overcharge_history', {
    p_vendor_id: vendorId,
    p_currency_code: currencyCode,
  });
  if (error) throw new Error(`Could not load vendor history: ${error.message}`);
  const row = (data as { paid_count: number | string; paid_sum: number | string }[])[0];
  return { count: Number(row?.paid_count ?? 0), sum: Number(row?.paid_sum ?? 0) };
}

/** Vendor ids that have at least one paid bill. */
export async function getPaidVendorIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('bills').select('vendor_id').eq('status', 'paid').not('vendor_id', 'is', null);
  if (error) throw new Error(`Could not load payment history: ${error.message}`);
  return new Set((data as { vendor_id: string }[]).map((r) => r.vendor_id));
}
