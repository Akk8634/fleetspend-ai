'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Demo mode only: wipes uploaded bills and restores the seed data. */
export function ResetDemoButton({ demoMode }: { demoMode: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!demoMode) return null;

  async function reset() {
    if (!window.confirm('Reset the demo? This deletes every uploaded bill and restores the sample vendor history.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Reset failed');
      setMessage('Demo reset. Upload some bills to start again.');
      router.push('/');
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {message && <span className="text-xs text-slate-500" role="status">{message}</span>}
      <button
        type="button"
        onClick={reset}
        disabled={busy}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? 'Resetting…' : 'Reset demo'}
      </button>
    </div>
  );
}
