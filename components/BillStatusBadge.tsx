import type { BillStatus } from '@/lib/db/types';
import { STATUS_LABEL } from '@/lib/ui/labels';

const STYLES: Record<BillStatus, string> = {
  uploaded: 'bg-gray-100 text-gray-700 ring-gray-300',
  extracted: 'bg-blue-50 text-blue-700 ring-blue-200',
  needs_review: 'bg-amber-50 text-amber-800 ring-amber-300',
  ready: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  flagged: 'bg-red-50 text-red-700 ring-red-200',
  payout_pending: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  paid: 'bg-teal-50 text-teal-700 ring-teal-200',
  payout_failed: 'bg-rose-100 text-rose-800 ring-rose-300',
};

const DOTS: Record<BillStatus, string> = {
  uploaded: 'bg-gray-400',
  extracted: 'bg-blue-500',
  needs_review: 'bg-amber-500',
  ready: 'bg-emerald-500',
  flagged: 'bg-red-500',
  payout_pending: 'bg-indigo-500 animate-pulse',
  paid: 'bg-teal-500',
  payout_failed: 'bg-rose-600',
};

export function BillStatusBadge({ status }: { status: BillStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}
