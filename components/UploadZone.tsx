'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { Flag } from '@/lib/checks/types';
import type { BillStatus } from '@/lib/db/types';
import { ALLOWED_MIME_TYPES, MAX_FILE_BYTES, MAX_FILES } from '@/lib/uploads/validateUpload';
import { CHECK_LABEL } from '@/lib/ui/labels';
import { BillStatusBadge } from './BillStatusBadge';

const SAMPLE_FILES = [
  'ready-1.jpg', 'ready-2.jpg', 'ready-3.jpg', 'ready-4.jpg',
  'duplicate.jpg', 'overcharge.jpg', 'new-payee.jpg', 'needs-review.jpg',
];

type Row = {
  key: string;
  name: string;
  phase: 'waiting' | 'uploading' | 'reading' | 'done' | 'error';
  billId?: string;
  status?: BillStatus;
  flags?: Flag[];
  message?: string;
};

function preValidate(file: File): string | null {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) return 'Use a JPG, PNG or PDF file.';
  if (file.size > MAX_FILE_BYTES) return 'File is larger than 10 MB.';
  if (file.size === 0) return 'File is empty.';
  return null;
}

/**
 * Drag-and-drop bill upload. Files are uploaded one per request (keeps each request
 * small enough for serverless limits), then processed strictly one after another in
 * upload order so duplicates inside a batch are caught (Requirement 1.10).
 */
export function UploadZone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function run(files: File[]) {
    if (busy || files.length === 0) return;
    setNotice(null);
    if (files.length > MAX_FILES) {
      setNotice(`You can upload at most ${MAX_FILES} files at once; the first ${MAX_FILES} were taken.`);
      files = files.slice(0, MAX_FILES);
    }

    const batch: Row[] = files.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, phase: 'waiting' }));
    setRows(batch);
    setBusy(true);

    // 1) Upload, in order.
    const uploaded: { key: string; billId: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const { key } = batch[i];
      const problem = preValidate(files[i]);
      if (problem) {
        update(key, { phase: 'error', message: problem });
        continue;
      }
      update(key, { phase: 'uploading' });
      try {
        const body = new FormData();
        body.append('files', files[i]);
        const res = await fetch('/api/bills/upload', { method: 'POST', body });
        const data = await res.json();
        const result = data.results?.[0];
        if (!res.ok || !result?.billId) throw new Error(result?.error ?? data.error ?? 'Upload failed');
        uploaded.push({ key, billId: result.billId });
        update(key, { phase: 'waiting', billId: result.billId, status: 'uploaded' });
      } catch (err) {
        update(key, { phase: 'error', message: err instanceof Error ? err.message : 'Upload failed' });
      }
    }

    // 2) Process strictly one after another; one failure never stops the rest.
    for (const { key, billId } of uploaded) {
      update(key, { phase: 'reading' });
      try {
        const res = await fetch(`/api/bills/${billId}/process`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Processing failed');
        update(key, { phase: 'done', status: data.status, flags: data.flags, message: data.error });
      } catch (err) {
        update(key, { phase: 'error', message: err instanceof Error ? err.message : 'Processing failed' });
      }
      router.refresh();
    }

    setBusy(false);
    router.refresh();
  }

  async function runSamples() {
    setNotice(null);
    try {
      const files = await Promise.all(
        SAMPLE_FILES.map(async (name) => {
          const res = await fetch(`/samples/${name}`);
          if (!res.ok) throw new Error(`Missing sample ${name}`);
          return new File([await res.blob()], name, { type: 'image/jpeg' });
        }),
      );
      await run(files);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not load the sample bills');
    }
  }

  return (
    <section aria-labelledby="upload-heading" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="upload-heading" className="text-base font-semibold text-slate-900">Upload bills</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Photos or PDFs of fuel, repair, parts and driver bills. The AI reads each one and checks it before anything is paid.
          </p>
        </div>
        <button
          type="button"
          onClick={runSamples}
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700 disabled:opacity-50"
        >
          Try the 8 sample bills
        </button>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); run(Array.from(e.dataTransfer.files)); }}
        className={`mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-slate-50'
        }`}
      >
        <svg className="h-8 w-8 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <p className="mt-2 text-sm text-slate-600">
          Drag bills here, or{' '}
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="font-medium text-indigo-600 underline-offset-2 hover:underline disabled:opacity-50">
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-slate-400">JPG, PNG or PDF · up to 10 MB each · up to {MAX_FILES} at once · USD bills</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED_MIME_TYPES.join(',')}
          className="sr-only"
          onChange={(e) => { run(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
      </div>

      {notice && <p className="mt-3 text-sm text-amber-700" role="status">{notice}</p>}

      {rows.length > 0 && (
        <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
          <span>
            {busy
              ? `Processing ${rows.filter((r) => r.phase === 'done' || r.phase === 'error').length + 1} of ${rows.length}…`
              : 'Upload finished. Live status is in the bill list below.'}
          </span>
          {!busy && (
            <button type="button" onClick={() => setRows([])} className="font-medium text-slate-600 hover:text-slate-900">
              Clear
            </button>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{r.name}</span>
              <span className="flex flex-wrap items-center gap-2">
                {(r.phase === 'uploading' || r.phase === 'reading') && (
                  <span className="inline-flex items-center gap-1.5 text-slate-500">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" aria-hidden />
                    {r.phase === 'uploading' ? 'Uploading…' : 'AI is reading the bill…'}
                  </span>
                )}
                {r.phase === 'waiting' && <span className="text-slate-400">Queued</span>}
                {r.phase === 'error' && <span className="text-red-600">{r.message}</span>}
                {r.phase === 'done' && r.status && (
                  <>
                    {r.flags?.map((f) => (
                      <span key={f.check_name} title={f.reason} className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">
                        {CHECK_LABEL[f.check_name]}
                      </span>
                    ))}
                    <BillStatusBadge status={r.status} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
