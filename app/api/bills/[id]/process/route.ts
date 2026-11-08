import { createServerClient } from '@/lib/db/client';
import { getPolicyLimitMinorUnits } from '@/lib/db/checks';
import { errorResponse, json, jsonError } from '@/lib/http';
import { processBill } from '@/lib/pipeline/processBill';
import { createSupabaseStore } from '@/lib/pipeline/store';

// Gemini: 20 s timeout + 5 s wait + 20 s retry, plus storage and database calls.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/bills/[id]/process — extract, check and classify one uploaded bill. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError(400, 'Invalid bill id.');

  try {
    const result = await processBill(id, {
      store: createSupabaseStore(createServerClient()),
      policyLimit: getPolicyLimitMinorUnits(),
    });
    return json(result);
  } catch (err) {
    return errorResponse(err, 'process');
  }
}
