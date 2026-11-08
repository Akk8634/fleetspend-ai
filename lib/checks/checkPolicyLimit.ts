import { formatCurrency } from '../money/formatCurrency';
import type { Flag } from './types';

/**
 * Pure: flags a bill above the per-bill spending limit.
 * A null limit means the check is disabled (bad or missing configuration).
 */
export function checkPolicyLimit(amount: number, limit: number | null): Flag | null {
  if (limit === null || amount <= limit) return null;
  return {
    check_name: 'policy_limit',
    reason: `Amount of ${formatCurrency(amount)} is above your per-bill limit of ${formatCurrency(limit)}.`,
  };
}
