import { connection } from 'next/server';
import { createServerClient } from '@/lib/db/client';

/**
 * GET /api/health — tiny liveness check, called daily by the Vercel Cron in vercel.json.
 * Runs one cheap query so the Supabase free-tier project never pauses for inactivity.
 * Returns no data beyond up/down.
 */
export async function GET() {
  await connection(); // always run at request time, never prerendered or cached
  const started = Date.now();
  try {
    const { error } = await createServerClient().from('vendors').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw new Error(error.message);
    return Response.json({ ok: true, db: 'up', ms: Date.now() - started }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[health]', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, db: 'down' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
