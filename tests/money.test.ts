import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { InvalidAmountError, parseAmountText } from '../lib/money/parseAmountText';
import { formatCurrency } from '../lib/money/formatCurrency';

describe('parseAmountText', () => {
  it.each([
    ['125', 12500],
    ['125.50', 12550],
    ['125.5', 12550],
    ['5.5', 550],
    ['0.01', 1],
    ['1,250.50', 125050],
    ['1,234,567.89', 123456789],
    ['007.10', 710],
  ] as const)('parses %s -> %d', (text, expected) => {
    expect(parseAmountText(text, 'USD')).toBe(expected);
  });

  it('parses the maximum allowed amount', () => {
    expect(parseAmountText('9999999.99', 'USD')).toBe(999_999_999);
    expect(parseAmountText('9,999,999.99', 'USD')).toBe(999_999_999);
  });

  it('tolerates spaces and a leading dollar sign', () => {
    expect(parseAmountText('  $1,250.50 ', 'USD')).toBe(125050);
    expect(parseAmountText('$ 45', 'USD')).toBe(4500);
  });

  it.each([
    'abc', '', '   ', '12.345', '0', '0.00', '-5.00', '1,25.00', '12,34', '1.2.3',
    '10000000.00', '12,345,678.90', '99999999999999999999', '5.', '.50', '1 250.00', '€12.00',
  ])('rejects %j', (text) => {
    expect(() => parseAmountText(text, 'USD')).toThrow(InvalidAmountError);
  });

  it('rejects unsupported currencies', () => {
    expect(() => parseAmountText('10.00', 'EUR')).toThrow(/unsupported currency EUR/);
  });
});

describe('formatCurrency', () => {
  it.each([
    [22000, '$220.00'],
    [100, '$1.00'],
    [5, '$0.05'],
    [0, '$0.00'],
    [99, '$0.99'],
    [125050, '$1,250.50'],
    [999_999_999, '$9,999,999.99'],
  ])('formats %d -> %s', (cents, expected) => {
    expect(formatCurrency(cents)).toBe(expected);
  });

  it('rejects non-integers', () => {
    expect(() => formatCurrency(1.5)).toThrow(TypeError);
  });
});

describe('Feature: invoice-processing, Property 6: Amount conversion round-trip', () => {
  const dollarsAndCents = fc.tuple(
    fc.integer({ min: 0, max: 9_999_999 }),
    fc.integer({ min: 0, max: 99 }),
  ).filter(([d, c]) => d * 100 + c >= 1);

  it('plain "D.CC" text converts to exactly D*100 + C', () => {
    fc.assert(
      fc.property(dollarsAndCents, ([dollars, cents]) => {
        const text = `${dollars}.${String(cents).padStart(2, '0')}`;
        expect(parseAmountText(text, 'USD')).toBe(dollars * 100 + cents);
      }),
      { numRuns: 200 },
    );
  });

  it('formatted text (with thousands separators) converts back to the same cents', () => {
    fc.assert(
      fc.property(dollarsAndCents, ([dollars, cents]) => {
        const minor = dollars * 100 + cents;
        expect(parseAmountText(formatCurrency(minor), 'USD')).toBe(minor);
      }),
      { numRuns: 200 },
    );
  });
});
