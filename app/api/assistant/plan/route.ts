import { createServerClient } from '@/lib/db/client';
import { listUserBills } from '@/lib/db/bills';
import { listVendors } from '@/lib/db/vendors';
import { json, jsonError } from '@/lib/http';
import { AssistantInputError, AssistantUnavailableError, planPayment } from '@/lib/assistant/planPayment';

export const maxDuration = 30;

/**
 * POST /api/assistant/plan — { instruction } -> payment plan (or a clarification question).
 * Suggest-only: nothing is paid here; the Owner approves in the approval dialog.
 */
export async function POST(request: Request) {
  let body: { instruction?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Expected a JSON body.');
  }

  const supabase = createServerClient();
  try {
    const result = await planPayment(body.instruction, {
      listPayableBills: async () =>
        (await listUserBills(supabase)).filter((b) => ['ready', 'flagged', 'payout_failed'].includes(b.status)),
      listVendorNames: async () => (await listVendors(supabase)).map((v) => v.name),
    });
    return json(result);
  } catch (err) {
    if (err instanceof AssistantInputError) return jsonError(400, err.message);
    if (err instanceof AssistantUnavailableError) {
      console.warn('[assistant] unavailable:', err.detail);
      return jsonError(502, err.message);
    }
    console.error('[assistant]', err instanceof Error ? err.message : err);
    return jsonError(500, 'Something went wrong. Please try again.');
  }
}
