import { createServerClient } from '../db/client';
import { getPayPalConfig } from '../paypal/config';
import { createPayPalClient } from '../paypal/client';
import { jsonError } from '../http';
import { PaymentInputError, type PaymentDeps } from './approveAndPay';
import { ApprovalRejectedError, BatchNotFoundError, createSupabasePaymentStore } from './store';

/** Server-side wiring for payment routes. Returns null when PayPal is not configured. */
export function createPaymentDeps(): PaymentDeps | null {
  const config = getPayPalConfig();
  if (!config) return null;
  return { store: createSupabasePaymentStore(createServerClient()), paypal: createPayPalClient({ config }) };
}

export const payPalNotConfigured = () => jsonError(503, 'PayPal is not configured.');

export function paymentErrorResponse(err: unknown, context: string): Response {
  if (err instanceof PaymentInputError) return jsonError(400, err.message);
  if (err instanceof ApprovalRejectedError) return jsonError(409, err.message, { problems: err.problems });
  if (err instanceof BatchNotFoundError) return jsonError(404, err.message);
  console.error(`[${context}]`, err instanceof Error ? err.message : err);
  return jsonError(500, 'Something went wrong with the payment. Please refresh and check its status.');
}
