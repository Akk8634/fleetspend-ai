import type { CheckName } from '../checks/types';

export type BillStatus = 'uploaded' | 'extracted' | 'needs_review' | 'ready' | 'flagged' | 'paid';

export const CORE_FIELDS = ['vendor_name', 'amount_text', 'currency_code', 'bill_date'] as const;

export type Bill = {
  id: string;
  vendor_id: string | null;
  storage_path: string;
  original_filename: string;
  status: BillStatus;
  vendor_name_raw: string | null;
  amount_text: string | null;
  amount_minor_units: number | null;
  currency_code: string | null;
  bill_date: string | null; // YYYY-MM-DD
  invoice_number: string | null;
  payee_email: string | null;
  category: string | null;
  confidence: Record<string, number> | null;
  low_confidence_fields: string[] | null;
  review_message: string | null;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
};

export type Vendor = {
  id: string;
  name: string;
  normalized_name: string;
  paypal_email: string | null;
  category: string | null;
  created_at: string;
};

export type StoredFlag = {
  id: string;
  bill_id: string;
  check_name: CheckName;
  reason: string;
  created_at: string;
};

/** A bill joined with its vendor name and flags, for the UI and API responses. */
export type BillWithDetails = Bill & {
  vendor_name: string | null;
  flags: Pick<StoredFlag, 'check_name' | 'reason'>[];
};
