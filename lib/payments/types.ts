export type PayoutOutcome = 'queued' | 'pending' | 'success' | 'failed';

export type PayoutItem = {
  id: string;
  batch_id: string;
  bill_id: string;
  receiver_email: string;
  amount_minor_units: number;
  currency_code: 'USD';
  note: string;
  override_reason: string | null;
  outcome: PayoutOutcome;
  paypal_item_id: string | null;
  transaction_id: string | null;
  transaction_status: string | null;
  error_message: string | null;
};

export type PayoutBatch = {
  id: string;
  paypal_batch_id: string | null;
  status: string;
  item_count: number;
  total_minor_units: number;
  currency_code: 'USD';
  approved_by: string;
  error_name: string | null;
  error_message: string | null;
  finished: boolean;
  /** Added by migration 009; absent before it runs. */
  source?: 'manual' | 'assistant';
  assistant_instruction?: string | null;
  assistant_summary?: string | null;
  created_at: string;
  updated_at: string;
};

export type PayoutBatchWithItems = PayoutBatch & { items: PayoutItem[] };

/** One item's status as fetched from PayPal by the server. */
export type SyncedItem = {
  sender_item_id: string;
  paypal_item_id: string | null;
  transaction_id: string | null;
  transaction_status: string | null;
  outcome: 'pending' | 'success' | 'failed';
  error_message: string | null;
};

export type ApprovalProblem = { bill_id: string | null; label: string; reason: string };

/** Mirrors the forward-only rule enforced in SQL (payout_items_guard / apply_payout_sync). */
export function nextOutcome(current: PayoutOutcome, incoming: PayoutOutcome): PayoutOutcome {
  if (current === 'success' || current === 'failed') return current;
  if (current === 'pending' && incoming === 'queued') return current;
  return incoming;
}
