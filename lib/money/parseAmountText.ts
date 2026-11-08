/**
 * Convert an amount exactly as printed on a bill (e.g. "1,250.50") into
 * integer minor units (cents). No floating-point arithmetic is used.
 *
 * Used for both AI-extracted amount_text and the owner's corrected amount.
 */

export const MIN_MINOR_UNITS = 1;
export const MAX_MINOR_UNITS = 999_999_999;

/** Decimal places per supported currency. Only USD is supported in this version. */
const CURRENCY_DECIMALS: Record<string, number> = { USD: 2 };

export class InvalidAmountError extends Error {
  constructor(public readonly amountText: string, reason = 'is not a valid amount') {
    super(`"${amountText}" ${reason}`);
    this.name = 'InvalidAmountError';
  }
}

// Either plain digits ("1250") or correctly grouped thousands ("1,250", "12,345,678"),
// optionally followed by one or two decimal places.
const AMOUNT_PATTERN = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

export function parseAmountText(amountText: string, currencyCode: string): number {
  const decimals = CURRENCY_DECIMALS[currencyCode];
  if (decimals === undefined) {
    throw new InvalidAmountError(amountText, `uses unsupported currency ${currencyCode}`);
  }

  // Tolerate surrounding spaces and a leading "$" as printed on US bills.
  const cleaned = amountText.trim().replace(/^\$\s*/, '');
  const match = cleaned.match(AMOUNT_PATTERN);
  if (!match) {
    throw new InvalidAmountError(amountText);
  }

  const wholeDigits = match[1].replace(/,/g, '');
  const fracDigits = (match[2] ?? '').padEnd(decimals, '0');

  // Reject absurdly long inputs before converting, so parseInt never loses precision.
  if (wholeDigits.replace(/^0+/, '').length > 10) {
    throw new InvalidAmountError(amountText, 'is out of range');
  }

  const result = parseInt(wholeDigits, 10) * 10 ** decimals + parseInt(fracDigits, 10);
  if (result < MIN_MINOR_UNITS || result > MAX_MINOR_UNITS) {
    throw new InvalidAmountError(amountText, 'is out of range');
  }
  return result;
}
