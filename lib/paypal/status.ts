export type ItemOutcome = 'pending' | 'success' | 'failed';

const SUCCESS = new Set(['SUCCESS']);
const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED']);
// PENDING, ONHOLD, UNCLAIMED, NEW and anything unknown stay pending until PayPal says otherwise.

/** Map a PayPal payout item transaction_status to our outcome (Requirement 3.2). */
export function toItemOutcome(transactionStatus: string | null | undefined): ItemOutcome {
  const s = (transactionStatus ?? '').trim().toUpperCase();
  if (SUCCESS.has(s)) return 'success';
  if (FAILED.has(s)) return 'failed';
  return 'pending';
}

/** Plain-English explanation of a failed or waiting item. */
export function describeTransactionStatus(transactionStatus: string | null | undefined, errorMessage?: string | null): string {
  if (errorMessage) return errorMessage;
  switch ((transactionStatus ?? '').toUpperCase()) {
    case 'UNCLAIMED': return 'Waiting for the receiver to claim the payment.';
    case 'ONHOLD': return 'PayPal is reviewing this payment.';
    case 'RETURNED': return 'Payment was returned (receiver did not claim it).';
    case 'BLOCKED': return 'PayPal blocked this payment.';
    case 'REFUNDED': return 'Payment was refunded.';
    case 'REVERSED': return 'Payment was reversed.';
    case 'DENIED': return 'PayPal denied this payment.';
    case 'CANCELED': return 'Payment was canceled.';
    case 'FAILED': return 'PayPal could not complete this payment.';
    default: return '';
  }
}
