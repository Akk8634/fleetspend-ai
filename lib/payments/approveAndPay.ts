import { z } from 'zod';
import { buildPayoutRequest } from '../paypal/buildPayoutRequest';
import { PayPalApiError, PayPalNetworkError, type PayPalClient } from '../paypal/client';
import { describeTransactionStatus, toItemOutcome } from '../paypal/status';
import type { PaymentStore } from './store';
import type { PayoutBatchWithItems, SyncedItem } from './types';

export const OWNER = 'demo_owner';
export const MAX_BILLS_PER_APPROVAL = 50;

export type PaymentDeps = { store: PaymentStore; paypal: PayPalClient };

export const approvalSchema = z.object({
  billIds: z
    .array(z.uuid('Invalid bill id'))
    .min(1, 'Select at least one bill')
    .max(MAX_BILLS_PER_APPROVAL, `At most ${MAX_BILLS_PER_APPROVAL} bills can be paid at once`)
    .refine((ids) => new Set(ids).size === ids.length, 'The same bill was selected twice'),
  overrides: z.record(z.string(), z.string().trim().max(500, 'Override reasons must be at most 500 characters')).default({}),
  /** Set when the selection came from the AI Payment Assistant (stored for the audit trail). */
  plan: z
    .object({
      instruction: z.string().trim().min(1).max(300),
      summary: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export type ApprovalPlan = { instruction: string; summary?: string };

export class PaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentInputError';
  }
}

/**
 * The Owner's approval: create the batch atomically (bills -> payout_pending),
 * send it to PayPal, then fetch the first status. The AI never calls this.
 */
export async function approveAndPay(input: unknown, deps: PaymentDeps): Promise<PayoutBatchWithItems> {
  const parsed = approvalSchema.safeParse(input);
  if (!parsed.success) throw new PaymentInputError(parsed.error.issues[0]?.message ?? 'Invalid approval');

  const overrides = Object.fromEntries(
    Object.entries(parsed.data.overrides).filter(([id, reason]) => parsed.data.billIds.includes(id) && reason.length > 0),
  );
  const batchId = await deps.store.approveAndCreateBatch(parsed.data.billIds, overrides, OWNER, parsed.data.plan);

  await submitBatch(batchId, deps);
  const batch = await deps.store.getBatch(batchId);
  // Only fetch status if PayPal accepted the batch. If the outcome is unknown, do NOT resend
  // in this request (it could double the wait); a later sync resends with the same request id.
  return batch.paypal_batch_id ? syncBatch(batchId, deps) : batch;
}

/** PayPal says this request id was already used: the money may have moved, so never mark it failed. */
function isDuplicateRequest(err: PayPalApiError) {
  return /DUPLICATE|ALREADY/i.test(err.errorName) || /sender_batch_id/i.test(err.message);
}

/**
 * Send (or safely re-send) a batch to PayPal. The batch id is both sender_batch_id
 * and PayPal-Request-Id, so a resend can never create a second payout.
 */
export async function submitBatch(batchId: string, deps: PaymentDeps): Promise<void> {
  const batch = await deps.store.getBatch(batchId);
  if (batch.paypal_batch_id || batch.status !== 'submitting') return;

  const request = buildPayoutRequest(
    batch.id,
    batch.items.map((i) => ({ id: i.id, receiver_email: i.receiver_email, amount_minor_units: i.amount_minor_units, currency_code: 'USD', note: i.note })),
  );

  try {
    const res = await deps.paypal.createPayout(request, batch.id);
    await deps.store.markBatchSubmitted(batch.id, res.batch_header.payout_batch_id, res.batch_header.batch_status);
  } catch (err) {
    if (err instanceof PayPalApiError && err.isClientError && !isDuplicateRequest(err)) {
      await deps.store.markBatchRejected(batch.id, err.errorName, `PayPal rejected the payment: ${err.message}`);
      return;
    }
    if (err instanceof PayPalApiError || err instanceof PayPalNetworkError) {
      // Outcome unknown (timeout, 5xx, duplicate): keep 'submitting'; the next sync resends with the same request id.
      console.warn(`[payments] batch ${batch.id} not confirmed by PayPal yet: ${err.message}`);
      return;
    }
    throw err;
  }
}

/** Fetch the batch from PayPal (server side) and apply item outcomes. Safe to call repeatedly. */
export async function syncBatch(batchId: string, deps: PaymentDeps): Promise<PayoutBatchWithItems> {
  let batch = await deps.store.getBatch(batchId);
  if (batch.finished) return batch;

  if (!batch.paypal_batch_id) {
    if (batch.status !== 'submitting') return batch;
    await submitBatch(batchId, deps);
    batch = await deps.store.getBatch(batchId);
    if (!batch.paypal_batch_id) return batch;
  }

  let res;
  try {
    res = await deps.paypal.getPayout(batch.paypal_batch_id);
  } catch (err) {
    if (err instanceof PayPalApiError || err instanceof PayPalNetworkError) {
      console.warn(`[payments] could not refresh batch ${batch.id}: ${err.message}`);
      return batch;
    }
    throw err;
  }

  const ours = new Set(batch.items.map((i) => i.id));
  const items: SyncedItem[] = (res.items ?? [])
    .filter((i) => i.payout_item?.sender_item_id && ours.has(i.payout_item.sender_item_id))
    .map((i) => {
      const outcome = toItemOutcome(i.transaction_status);
      return {
        sender_item_id: i.payout_item!.sender_item_id!,
        paypal_item_id: i.payout_item_id ?? null,
        transaction_id: i.transaction_id ?? null,
        transaction_status: i.transaction_status ?? null,
        outcome,
        error_message: outcome === 'failed' ? describeTransactionStatus(i.transaction_status, i.errors?.message) : null,
      };
    });

  await deps.store.applyPayoutSync(batch.id, res.batch_header.batch_status ?? null, items);
  return deps.store.getBatch(batch.id);
}
