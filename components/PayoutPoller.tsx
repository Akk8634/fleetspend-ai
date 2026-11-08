'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const INTERVAL_MS = 5_000;
const MAX_DURATION_MS = 2 * 60_000;

/**
 * Keeps unfinished payout batches fresh: asks the server to sync each one from PayPal
 * every 5 s for at most 2 minutes, then refreshes the page data (Requirement 3.7).
 */
export function PayoutPoller({ batchIds }: { batchIds: string[] }) {
  const router = useRouter();
  const key = batchIds.join(',');
  const startedRef = useRef<{ key: string; at: number } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (!key) return;
    if (startedRef.current?.key !== key) startedRef.current = { key, at: Date.now() };
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedRef.current!.at > MAX_DURATION_MS) {
        setGaveUp(true);
        return;
      }
      await Promise.allSettled(key.split(',').map((id) => fetch(`/api/payouts/${id}/sync`, { method: 'POST' })));
      if (!cancelled) router.refresh();
    };

    const timer = setInterval(tick, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, router]);

  if (!key) return null;
  return (
    <p className="text-xs text-slate-500" role="status">
      {gaveUp ? 'Still waiting on PayPal — use “Refresh status” to check again.' : 'Checking PayPal for updates every few seconds…'}
    </p>
  );
}

/** Manual "Refresh status" for one batch. */
export function RefreshBatchButton({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/payouts/${batchId}/sync`, { method: 'POST' }).catch(() => null);
        setBusy(false);
        router.refresh();
      }}
      className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
    >
      {busy ? 'Refreshing…' : 'Refresh status'}
    </button>
  );
}
