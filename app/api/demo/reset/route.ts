import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/db/client';
import { json, jsonError } from '@/lib/http';

const BUCKET = 'bills';

/** Every object path in the bucket. Uploads are stored one level deep: <uuid>/<file>. */
async function listAllPaths(supabase: SupabaseClient): Promise<string[]> {
  const paths: string[] = [];
  const list = async (prefix: string) => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
      if (error) throw new Error(`Could not list stored files: ${error.message}`);
      for (const entry of data) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) await list(path); // folder
        else paths.push(path);
      }
      if (data.length < 1000) break;
    }
  };
  await list('');
  return paths;
}

/** POST /api/demo/reset — demo mode only: delete uploads and restore the seed data. */
export async function POST() {
  if (process.env.DEMO_MODE !== 'true') {
    return jsonError(403, 'Reset is only available in demo mode.');
  }

  try {
    const supabase = createServerClient();
    const paths = await listAllPaths(supabase);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      if (error) throw new Error(`Could not delete stored files: ${error.message}`);
    }

    const { error } = await supabase.rpc('reset_demo');
    if (error) throw new Error(`reset_demo failed: ${error.message}`);

    return json({ success: true, deletedFiles: paths.length });
  } catch (err) {
    console.error('[demo/reset]', err instanceof Error ? err.message : err);
    return jsonError(500, 'Could not reset the demo. Please try again.');
  }
}
