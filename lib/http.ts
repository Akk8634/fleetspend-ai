import { BillNotFoundError } from './db/bills';
import { BillNotReviewableError, CorrectionValidationError } from './pipeline/correctBill';

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const jsonError = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status });

/** Map known errors to HTTP responses; anything else is a 500 with a safe message. */
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof BillNotFoundError) return jsonError(404, err.message);
  if (err instanceof CorrectionValidationError) return jsonError(400, err.message, { fieldErrors: err.fieldErrors });
  if (err instanceof BillNotReviewableError) return jsonError(409, err.message);
  console.error(`[${context}]`, err instanceof Error ? err.message : err);
  return jsonError(500, 'Something went wrong. Please try again.');
}
