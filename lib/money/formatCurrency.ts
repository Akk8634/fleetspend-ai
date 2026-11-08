/**
 * Format integer minor units (cents) as a USD display string, e.g. 125050 -> "$1,250.50".
 * Display only: never use the result in arithmetic or comparisons.
 */
export function formatCurrency(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new TypeError(`formatCurrency expects an integer number of cents, got ${minorUnits}`);
  }
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}
