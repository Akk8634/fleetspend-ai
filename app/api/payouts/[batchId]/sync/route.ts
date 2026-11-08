import { json, jsonError } from '@/lib/http';
import { syncBatch } from '@/lib/payments/approveAndPay';
import { createPaymentDeps, paymentErrorResponse, payPalNotConfigured } from '@/lib/payments/server';

export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/payouts/[batchId]/sync — refresh a batch's status from PayPal (server side). */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!UUID.test(batchId)) return jsonError(400, 'Invalid batch id.');

  const deps = createPaymentDeps();
  if (!deps) return payPalNotConfigured();

  try {
    return json({ batch: await syncBatch(batchId, deps) });
  } catch (err) {
    return paymentErrorResponse(err, 'payouts:sync');
  }
}
