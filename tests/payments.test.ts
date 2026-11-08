import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { approveAndPay, PaymentInputError, syncBatch } from '../lib/payments/approveAndPay';
import { ApprovalRejectedError, BatchNotFoundError, type PaymentStore } from '../lib/payments/store';
import { nextOutcome, type ApprovalProblem, type PayoutBatchWithItems, type PayoutOutcome, type SyncedItem } from '../lib/payments/types';
import { PayPalApiError, PayPalNetworkError, type PayPalClient, type PayPalGetPayoutResponse } from '../lib/paypal/client';
import type { PayPalPayoutRequest } from '../lib/paypal/buildPayoutRequest';

// ------------------------------------------------------------ fakes mirroring the SQL rules

type FakeBill = { id: string; status: string; payee_email: string | null; amount: number | null; currency: string; vendor: string };

class FakePaymentStore implements PaymentStore {
  bills = new Map<string, FakeBill>();
  batches = new Map<string, PayoutBatchWithItems>();
  private seq = 0;
  private uuid = () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;

  addBill(over: Partial<FakeBill> = {}) {
    const b: FakeBill = { id: this.uuid(), status: 'ready', payee_email: 'sb-x@personal.example.com', amount: 21000, currency: 'USD', vendor: 'Apex Fuel Co', ...over };
    this.bills.set(b.id, b);
    return b;
  }

  async approveAndCreateBatch(billIds: string[], overrides: Record<string, string>, actor: string) {
    const problems: ApprovalProblem[] = [];
    for (const id of billIds) {
      const b = this.bills.get(id);
      if (!b) { problems.push({ bill_id: id, label: 'Unknown bill', reason: 'Bill not found.' }); continue; }
      if (!['ready', 'flagged', 'payout_failed'].includes(b.status)) problems.push({ bill_id: id, label: b.vendor, reason: `Bill is ${b.status.replace('_', ' ')} and cannot be approved.` });
      if (b.status === 'flagged' && !overrides[id]?.trim()) problems.push({ bill_id: id, label: b.vendor, reason: 'Flagged bill: type a reason to approve it anyway.' });
      if (!b.payee_email) problems.push({ bill_id: id, label: b.vendor, reason: 'No PayPal email for this payee.' });
    }
    if (problems.length) throw new ApprovalRejectedError(problems);

    const batch: PayoutBatchWithItems = {
      id: this.uuid(), paypal_batch_id: null, status: 'submitting', item_count: billIds.length,
      total_minor_units: billIds.reduce((s, id) => s + this.bills.get(id)!.amount!, 0), currency_code: 'USD',
      approved_by: actor, error_name: null, error_message: null, finished: false, created_at: '', updated_at: '',
      items: [],
    };
    for (const id of billIds) {
      const b = this.bills.get(id)!;
      batch.items.push({
        id: this.uuid(), batch_id: batch.id, bill_id: id, receiver_email: b.payee_email!, amount_minor_units: b.amount!,
        currency_code: 'USD', note: `${b.vendor} · invoice`, override_reason: overrides[id] ?? null, outcome: 'queued',
        paypal_item_id: null, transaction_id: null, transaction_status: null, error_message: null,
      });
      b.status = 'payout_pending';
    }
    this.batches.set(batch.id, batch);
    return batch.id;
  }

  async getBatch(id: string) {
    const b = this.batches.get(id);
    if (!b) throw new BatchNotFoundError(id);
    return structuredClone(b);
  }
  async markBatchSubmitted(id: string, paypalId: string, status: string) {
    const b = this.batches.get(id)!;
    if (b.paypal_batch_id === paypalId) return;
    if (b.status !== 'submitting') throw new Error('not submitting');
    Object.assign(b, { paypal_batch_id: paypalId, status: status.toLowerCase() });
    b.items.forEach((i) => { if (i.outcome === 'queued') i.outcome = 'pending'; });
  }
  async markBatchRejected(id: string, name: string, message: string) {
    const b = this.batches.get(id)!;
    if (b.status !== 'submitting') throw new Error('not submitting');
    Object.assign(b, { status: 'failed', finished: true, error_name: name, error_message: message });
    b.items.forEach((i) => { i.outcome = 'failed'; i.error_message = message; this.bills.get(i.bill_id)!.status = 'payout_failed'; });
  }
  async applyPayoutSync(id: string, batchStatus: string | null, items: SyncedItem[]) {
    const b = this.batches.get(id)!;
    if (!b.paypal_batch_id) throw new Error('not accepted');
    if (batchStatus) b.status = batchStatus.toLowerCase();
    for (const s of items) {
      const item = b.items.find((i) => i.id === s.sender_item_id);
      if (!item || item.outcome === 'success' || item.outcome === 'failed') continue;
      item.outcome = nextOutcome(item.outcome, s.outcome);
      Object.assign(item, { paypal_item_id: s.paypal_item_id, transaction_id: s.transaction_id, transaction_status: s.transaction_status });
      if (s.outcome === 'failed') item.error_message = s.error_message;
      const bill = this.bills.get(item.bill_id)!;
      if (bill.status === 'payout_pending' && s.outcome !== 'pending') bill.status = s.outcome === 'success' ? 'paid' : 'payout_failed';
    }
    b.finished = b.items.every((i) => i.outcome === 'success' || i.outcome === 'failed');
  }
  async listRecentBatches() { return [...this.batches.values()]; }
}

class FakePayPal implements PayPalClient {
  created: { request: PayPalPayoutRequest; requestId: string }[] = [];
  createFailures: Error[] = [];
  statuses: Record<string, { status: string; error?: string }> = {}; // by sender_item_id
  defaultStatus = 'SUCCESS';
  getCalls = 0;

  async createPayout(request: PayPalPayoutRequest, requestId: string) {
    this.created.push({ request, requestId });
    const failure = this.createFailures.shift();
    if (failure) throw failure;
    return { batch_header: { payout_batch_id: `PPB-${requestId.slice(-4)}`, batch_status: 'PENDING' } };
  }
  async getPayout(paypalBatchId: string): Promise<PayPalGetPayoutResponse> {
    this.getCalls++;
    const last = this.created.at(-1)!;
    return {
      batch_header: { payout_batch_id: paypalBatchId, batch_status: 'PROCESSING' },
      items: last.request.items.map((i, n) => {
        const s = this.statuses[i.sender_item_id] ?? { status: this.defaultStatus };
        return {
          payout_item_id: `ITEM-${n}`, transaction_id: s.status === 'SUCCESS' ? `TX-${n}` : undefined,
          transaction_status: s.status, payout_item: { sender_item_id: i.sender_item_id },
          errors: s.error ? { name: 'RECEIVER_UNREGISTERED', message: s.error } : undefined,
        };
      }),
    };
  }
}

let store: FakePaymentStore;
let paypal: FakePayPal;
beforeEach(() => {
  store = new FakePaymentStore();
  paypal = new FakePayPal();
});
const deps = () => ({ store, paypal });
const statusOf = (id: string) => store.bills.get(id)!.status;

// ------------------------------------------------------------ flows

describe('approveAndPay', () => {
  it('pays every approved bill: one PayPal request, request id = batch id, bills become paid', async () => {
    const a = store.addBill({ amount: 21000 });
    const b = store.addBill({ amount: 32000, vendor: 'ProParts Supply' });
    const batch = await approveAndPay({ billIds: [a.id, b.id] }, deps());

    expect(paypal.created).toHaveLength(1);
    expect(paypal.created[0].requestId).toBe(batch.id);
    expect(paypal.created[0].request.sender_batch_header.sender_batch_id).toBe(batch.id);
    expect(paypal.created[0].request.items.map((i) => i.amount.value)).toEqual(['210.00', '320.00']);
    expect(batch).toMatchObject({ finished: true, total_minor_units: 53000, paypal_batch_id: expect.stringMatching(/^PPB-/) });
    expect(batch.items.every((i) => i.outcome === 'success' && i.transaction_id)).toBe(true);
    expect([statusOf(a.id), statusOf(b.id)]).toEqual(['paid', 'paid']);
  });

  it('PayPal 4xx rejection -> batch failed, bills payout_failed with PayPal\'s message', async () => {
    const a = store.addBill();
    paypal.createFailures.push(new PayPalApiError(422, 'INSUFFICIENT_FUNDS', 'Sender does not have sufficient funds.'));
    const batch = await approveAndPay({ billIds: [a.id] }, deps());
    expect(batch).toMatchObject({ status: 'failed', finished: true, error_name: 'INSUFFICIENT_FUNDS' });
    expect(batch.items[0].error_message).toContain('sufficient funds');
    expect(statusOf(a.id)).toBe('payout_failed');
  });

  it('network failure keeps the batch submitting; the next sync resends with the SAME request id', async () => {
    const a = store.addBill();
    paypal.createFailures.push(new PayPalNetworkError('PayPal did not answer within 30 s'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await approveAndPay({ billIds: [a.id] }, deps());
    expect(first).toMatchObject({ status: 'submitting', paypal_batch_id: null, finished: false });
    expect(statusOf(a.id)).toBe('payout_pending');

    const second = await syncBatch(first.id, deps());
    warn.mockRestore();
    expect(paypal.created.map((c) => c.requestId)).toEqual([first.id, first.id]);
    expect(second.finished).toBe(true);
    expect(statusOf(a.id)).toBe('paid');
  });

  it('a 5xx on create is treated as unknown, never as a rejection', async () => {
    const a = store.addBill();
    paypal.createFailures.push(new PayPalApiError(503, 'SERVICE_UNAVAILABLE', 'down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batch = await approveAndPay({ billIds: [a.id] }, deps());
    warn.mockRestore();
    expect(batch.status).toBe('submitting');
    expect(statusOf(a.id)).toBe('payout_pending');
  });

  it('a duplicate-request error is never marked as failed (money may have moved)', async () => {
    const a = store.addBill();
    paypal.createFailures.push(new PayPalApiError(400, 'DUPLICATE_REQUEST_ID', 'sender_batch_id already used'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batch = await approveAndPay({ billIds: [a.id] }, deps());
    warn.mockRestore();
    expect(batch.status).toBe('submitting');
    expect(statusOf(a.id)).not.toBe('payout_failed');
  });

  it('partial failure: one item succeeds, one fails with PayPal\'s reason', async () => {
    const a = store.addBill();
    const b = store.addBill({ vendor: 'Highway Diesel Inc' });
    paypal.defaultStatus = 'SUCCESS';
    const origCreate = paypal.createPayout.bind(paypal);
    paypal.createPayout = async (req, id) => {
      paypal.statuses[req.items[1].sender_item_id] = { status: 'FAILED', error: 'Receiver is unregistered.' };
      return origCreate(req, id);
    };
    const batch = await approveAndPay({ billIds: [a.id, b.id] }, deps());
    expect(statusOf(a.id)).toBe('paid');
    expect(statusOf(b.id)).toBe('payout_failed');
    expect(batch.items[1].error_message).toBe('Receiver is unregistered.');
    expect(batch.finished).toBe(true);
  });

  it('pending items stay paying until a later sync reports success; finished batches are not fetched again', async () => {
    const a = store.addBill();
    paypal.defaultStatus = 'UNCLAIMED';
    const batch = await approveAndPay({ billIds: [a.id] }, deps());
    expect(batch.finished).toBe(false);
    expect(statusOf(a.id)).toBe('payout_pending');

    paypal.defaultStatus = 'SUCCESS';
    await syncBatch(batch.id, deps());
    expect(statusOf(a.id)).toBe('paid');

    const calls = paypal.getCalls;
    await syncBatch(batch.id, deps());
    expect(paypal.getCalls).toBe(calls);
  });

  it('double submit: the second approval of the same bills is rejected and PayPal is called once', async () => {
    const a = store.addBill();
    const results = await Promise.allSettled([
      approveAndPay({ billIds: [a.id] }, deps()),
      approveAndPay({ billIds: [a.id] }, deps()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ApprovalRejectedError);
    expect(paypal.created).toHaveLength(1);
  });

  it('refuses to pay a bill that is already paid, without calling PayPal', async () => {
    const a = store.addBill({ status: 'paid' });
    const err = await approveAndPay({ billIds: [a.id] }, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect(err.problems[0].reason).toContain('paid');
    expect(paypal.created).toHaveLength(0);
  });

  it('requires an override reason for flagged bills and records it', async () => {
    const f = store.addBill({ status: 'flagged', amount: 45000 });
    await expect(approveAndPay({ billIds: [f.id] }, deps())).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(statusOf(f.id)).toBe('flagged');

    const batch = await approveAndPay({ billIds: [f.id], overrides: { [f.id]: '  Called Apex: price increase confirmed  ' } }, deps());
    expect(batch.items[0].override_reason).toBe('Called Apex: price increase confirmed');
    expect(statusOf(f.id)).toBe('paid');
  });

  it('a failed bill can be approved again in a new batch', async () => {
    const a = store.addBill();
    paypal.createFailures.push(new PayPalApiError(422, 'INSUFFICIENT_FUNDS', 'no funds'));
    const first = await approveAndPay({ billIds: [a.id] }, deps());
    const second = await approveAndPay({ billIds: [a.id] }, deps());
    expect(second.id).not.toBe(first.id);
    expect(statusOf(a.id)).toBe('paid');
  });

  it.each([
    [{ billIds: [] }, 'Select at least one bill'],
    [{ billIds: ['not-a-uuid'] }, 'Invalid bill id'],
    [{ billIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, 'At most 50'],
    [{ billIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'] }, 'twice'],
    [{ billIds: ['00000000-0000-4000-8000-000000000001'], overrides: { x: 'a'.repeat(501) } }, '500'],
  ])('rejects invalid input %#', async (input, message) => {
    const err = await approveAndPay(input, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentInputError);
    expect(err.message).toContain(message);
    expect(paypal.created).toHaveLength(0);
  });
});

// ------------------------------------------------------------ property

describe('Feature: payment-workflow, Property 10: Outcomes only move forward', () => {
  const outcomeArb = fc.constantFrom<PayoutOutcome>('queued', 'pending', 'success', 'failed');
  it('once success or failed, an outcome never changes; it never returns to queued', () => {
    fc.assert(
      fc.property(fc.array(outcomeArb, { maxLength: 30 }), (updates) => {
        let current: PayoutOutcome = 'queued';
        let finalSeen: PayoutOutcome | null = null;
        for (const u of updates) {
          const prev = current;
          current = nextOutcome(current, u);
          if (finalSeen) expect(current).toBe(finalSeen);
          if (prev !== 'queued') expect(current).not.toBe('queued');
          if (current === 'success' || current === 'failed') finalSeen ??= current;
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a bill reaches paid at most once across any sequence of syncs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('PENDING', 'SUCCESS', 'FAILED', 'UNCLAIMED', 'RETURNED'), { minLength: 1, maxLength: 8 }), async (seq) => {
        const s = new FakePaymentStore();
        const p = new FakePayPal();
        const bill = s.addBill();
        p.defaultStatus = 'PENDING';
        const batch = await approveAndPay({ billIds: [bill.id] }, { store: s, paypal: p });
        const seen: string[] = [];
        for (const status of seq) {
          p.defaultStatus = status;
          await syncBatch(batch.id, { store: s, paypal: p });
          seen.push(s.bills.get(bill.id)!.status);
        }
        const firstFinal = seen.findIndex((x) => x === 'paid' || x === 'payout_failed');
        if (firstFinal >= 0) expect(new Set(seen.slice(firstFinal)).size).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});
