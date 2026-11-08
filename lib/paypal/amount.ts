/**
 * Integer cents -> PayPal decimal string ("12550" -> "125.50").
 * The ONLY place in the app where money becomes a decimal string. Integer math only.
 */
export function centsToPayPalValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 1) {
    throw new RangeError(`Payout amount must be a positive integer number of cents, got ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
