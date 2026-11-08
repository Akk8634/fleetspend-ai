import type { Flag } from './types';

/** Pure: flags a vendor that has never been paid before. */
export function checkNewPayee(
  vendorId: string,
  vendorName: string,
  paidVendorIds: ReadonlySet<string>,
): Flag | null {
  if (paidVendorIds.has(vendorId)) return null;
  return {
    check_name: 'new_payee',
    reason: `First-time payee: ${vendorName} has no payment history.`,
  };
}
