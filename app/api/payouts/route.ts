import { json, jsonError } from '@/lib/http';
import { approveAndPay } from '@/lib/payments/approveAndPay';
import { createPaymentDeps, paymentErrorResponse, payPalNotConfigured } from '@/lib/payments/server';

// PayPal create (30 s timeout) + first status fetch, plus database calls.
export const maxDuration = 60;

/**
 * POST /api/payouts — the Owner approves bills and pays them via PayPal Payouts (sandbox).
 * Body: { billIds: string[], overrides?: { [billId]: reason } }
 */
export async function POST(request: Request) {
  const deps = createPaymentDeps();
  if (!deps) return payPalNotConfigured();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Expected a JSON body.');
  }

  try {
    const batch = await approveAndPay(body, deps);
    return json({ batch }, 201);
  } catch (err) {
    return paymentErrorResponse(err, 'payouts');
  }
}

/** GET /api/payouts — the 10 most recent payout batches with their items. */
export async function GET() {
  const deps = createPaymentDeps();
  if (!deps) return payPalNotConfigured();
  try {
    return json({ batches: await deps.store.listRecentBatches(10) });
  } catch (err) {
    return paymentErrorResponse(err, 'payouts:list');
  }
}
