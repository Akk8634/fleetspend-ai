import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeVendorName } from '../lib/vendors/normalizeVendorName';

describe('normalizeVendorName', () => {
  it.each([
    ['City Lube Stn.', 'city lube station'],
    ['City Lube Station', 'city lube station'],
    ['Apex Fuel Company', 'apex fuel'],
    ['Apex Fuel Co', 'apex fuel'],
    ['APEX FUEL CO.', 'apex fuel'],
    ['Metro Auto Repair Inc.', 'metro auto repair'],
    ['Driver Direct Ltd', 'driver direct'],
    ['  Highway  Diesel  Inc  ', 'highway diesel'],
    ['ProParts Supply', 'proparts supply'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeVendorName(input)).toBe(expected);
  });

  it('matches the normalized names used in the seed data', () => {
    const seeded = {
      'Apex Fuel Co': 'apex fuel',
      'Metro Auto Repair': 'metro auto repair',
      'ProParts Supply': 'proparts supply',
      'Driver Direct Ltd': 'driver direct',
      'City Lube Station': 'city lube station',
    };
    for (const [name, normalized] of Object.entries(seeded)) {
      expect(normalizeVendorName(name)).toBe(normalized);
    }
  });

  it('is idempotent: normalizing twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const once = normalizeVendorName(s);
        expect(normalizeVendorName(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('ignores letter case and surrounding whitespace', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        expect(normalizeVendorName(`  ${s.toUpperCase()}  `)).toBe(normalizeVendorName(s.toLowerCase()));
      }),
      { numRuns: 300 },
    );
  });
});
