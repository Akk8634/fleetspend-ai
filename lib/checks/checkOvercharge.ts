import { formatCurrency } from '../money/formatCurrency';
import type { Flag } from './types';

/**
 * Pure: flags a bill whose amount is more than 2x the vendor's average paid bill.
 * The comparison is amount * count > 2 * sum in BigInt, so there is no division,
 * no floats and no overflow. Needs at least 2 paid bills of history.
 */
export function checkOvercharge(
  bill: { amount_minor_units: number; vendor_name: string },
  history: { count: number; sum: number },
): Flag | null {
  if (history.count < 2) return null;

  const isOvercharge =
    BigInt(bill.amount_minor_units) * BigInt(history.count) > 2n * BigInt(history.sum);
  if (!isOvercharge) return null;

  const average = Math.round(history.sum / history.count); // display only
  return {
    check_name: 'overcharge',
    reason: `Amount of ${formatCurrency(bill.amount_minor_units)} is more than 2x the usual ${formatCurrency(average)} average for ${bill.vendor_name}.`,
  };
}
