import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApprovalProblem, PayoutBatch, PayoutBatchWithItems, PayoutItem, SyncedItem } from './types';

/** Thrown when the database refuses an approval; nothing was written. */
export class ApprovalRejectedError extends Error {
  constructor(public readonly problems: ApprovalProblem[]) {
    super(problems.length === 1 ? problems[0].reason : `${problems.length} bills cannot be paid yet.`);
    this.name = 'ApprovalRejectedError';
  }
}

export class BatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Payout batch ${id} not found`);
    this.name = 'BatchNotFoundError';
  }
}

export interface PaymentStore {
  approveAndCreateBatch(billIds: string[], overrides: Record<string, string>, actor: string): Promise<string>;
  getBatch(batchId: string): Promise<PayoutBatchWithItems>;
  markBatchSubmitted(batchId: string, paypalBatchId: string, status: string): Promise<void>;
  markBatchRejected(batchId: string, errorName: string, errorMessage: string): Promise<void>;
  applyPayoutSync(batchId: string, batchStatus: string | null, items: SyncedItem[]): Promise<void>;
  listRecentBatches(limit: number): Promise<PayoutBatchWithItems[]>;
}

function parseProblems(details: string | null | undefined): ApprovalProblem[] {
  try {
    const parsed = JSON.parse(details ?? '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed as ApprovalProblem[];
  } catch {
    /* fall through */
  }
  return [{ bill_id: null, label: 'Approval', reason: 'The selected bills cannot be paid right now.' }];
}

const BATCH_SELECT =
  '*, payout_items(id, batch_id, bill_id, receiver_email, amount_minor_units, currency_code, note, override_reason, outcome, paypal_item_id, transaction_id, transaction_status, error_message)';

type BatchRow = PayoutBatch & { total_minor_units: number | string; payout_items: PayoutItem[] | null };
const toBatch = ({ payout_items, ...b }: BatchRow): PayoutBatchWithItems => ({
  ...b,
  total_minor_units: Number(b.total_minor_units),
  items: payout_items ?? [],
});

export function createSupabasePaymentStore(supabase: SupabaseClient): PaymentStore {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      if (error.message === 'APPROVAL_REJECTED') throw new ApprovalRejectedError(parseProblems(error.details));
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return data;
  };

  return {
    async approveAndCreateBatch(billIds, overrides, actor) {
      const id = await rpc('approve_and_create_batch', { p_bill_ids: billIds, p_overrides: overrides, p_actor: actor });
      if (typeof id !== 'string') throw new Error('approve_and_create_batch returned no batch id');
      return id;
    },

    async getBatch(batchId) {
      const { data, error } = await supabase.from('payout_batches').select(BATCH_SELECT).eq('id', batchId).maybeSingle();
      if (error) throw new Error(`Could not load payout batch: ${error.message}`);
      if (!data) throw new BatchNotFoundError(batchId);
      return toBatch(data as BatchRow);
    },

    markBatchSubmitted: async (batchId, paypalBatchId, status) => {
      await rpc('mark_batch_submitted', { p_batch_id: batchId, p_paypal_batch_id: paypalBatchId, p_status: status });
    },
    markBatchRejected: async (batchId, errorName, errorMessage) => {
      await rpc('mark_batch_rejected', { p_batch_id: batchId, p_error_name: errorName, p_error_message: errorMessage });
    },
    applyPayoutSync: async (batchId, batchStatus, items) => {
      await rpc('apply_payout_sync', { p_batch_id: batchId, p_batch_status: batchStatus, p_items: items });
    },

    async listRecentBatches(limit) {
      const { data, error } = await supabase
        .from('payout_batches')
        .select(BATCH_SELECT)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`Could not load payouts: ${error.message}`);
      return (data as BatchRow[]).map(toBatch);
    },
  };
}
