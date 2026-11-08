import { createServerClient } from '@/lib/db/client';
import { getPolicyLimitMinorUnits } from '@/lib/db/checks';
import { errorResponse, json, jsonError } from '@/lib/http';
import { correctBill } from '@/lib/pipeline/correctBill';
import { createSupabaseStore } from '@/lib/pipeline/store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH /api/bills/[id]/correct — the owner fixes a needs_review bill; checks run again. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError(400, 'Invalid bill id.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Expected a JSON body.');
  }

  try {
    const result = await correctBill(id, body, {
      store: createSupabaseStore(createServerClient()),
      policyLimit: getPolicyLimitMinorUnits(),
    });
    return json(result);
  } catch (err) {
    return errorResponse(err, 'correct');
  }
}
