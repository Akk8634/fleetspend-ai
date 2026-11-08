import { randomUUID } from 'node:crypto';
import { createServerClient } from '@/lib/db/client';
import { json, jsonError } from '@/lib/http';
import { safeFileName, validateBatch, validateFile } from '@/lib/uploads/validateUpload';

type UploadResult = { filename: string; billId: string; status: 'uploaded' } | { filename: string; error: string };

/**
 * POST /api/bills/upload  (multipart/form-data, field name "files")
 * Stores each valid file privately and creates its bill (status 'uploaded').
 * One file failing never stops the others (Requirements 1.1–1.9).
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, 'Expected multipart/form-data with one or more "files".');
  }

  const files = form.getAll('files').filter((v): v is File => v instanceof File);
  const batchError = validateBatch(files);
  if (batchError) return jsonError(files.length > 0 ? 413 : 400, batchError);

  const supabase = createServerClient();
  const results: UploadResult[] = [];

  for (const file of files) {
    const fileError = validateFile(file);
    if (fileError) {
      results.push({ filename: file.name, error: fileError });
      continue;
    }

    const storagePath = `${randomUUID()}/${safeFileName(file.name)}`;
    const upload = await supabase.storage
      .from('bills')
      .upload(storagePath, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
    if (upload.error) {
      results.push({ filename: file.name, error: `${file.name}: could not store the file (${upload.error.message}).` });
      continue;
    }

    const { data: billId, error } = await supabase.rpc('create_bill', {
      p_storage_path: storagePath,
      p_original_filename: file.name.slice(0, 255),
    });
    if (error || typeof billId !== 'string') {
      const cleanup = await supabase.storage.from('bills').remove([storagePath]);
      if (cleanup.error) console.error('[upload] orphaned file left in storage:', storagePath);
      results.push({ filename: file.name, error: `${file.name}: could not save the bill record.` });
      continue;
    }

    results.push({ filename: file.name, billId, status: 'uploaded' });
  }

  return json({ results });
}
