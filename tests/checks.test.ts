import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkDuplicate, type BillForCheck, type ExistingBill } from '../lib/checks/checkDuplicate';
import { checkOvercharge } from '../lib/checks/checkOvercharge';
import { checkNewPayee } from '../lib/checks/checkNewPayee';
import { checkPolicyLimit } from '../lib/checks/checkPolicyLimit';

const bill = (over: Partial<BillForCheck> = {}): BillForCheck => ({
  id: 'b-new',
  vendor_id: 'v-metro',
  invoice_number: 'MAR-002',
  amount_minor_units: 92000,
  bill_date: '2026-03-30',
  ...over,
});
const existing = (over: Partial<ExistingBill> = {}): ExistingBill => ({
  ...bill({ id: 'b-old' }),
  vendor_name: 'Metro Auto Repair',
  ...over,
});

// ---------------------------------------------------------------- unit tests

describe('checkDuplicate', () => {
  it('no flag for an empty history', () => {
    expect(checkDuplicate(bill(), [])).toBeNull();
  });

  it('never matches a bill against itself', () => {
    expect(checkDuplicate(bill(), [existing({ id: 'b-new' })])).toBeNull();
  });

  it('flags the same vendor + invoice number', () => {
    const flag = checkDuplicate(bill({ amount_minor_units: 1, bill_date: '2026-11-01' }), [existing()]);
    expect(flag).toEqual({
      check_name: 'duplicate',
      reason: 'Possible duplicate of invoice MAR-002 from Metro Auto Repair on 2026-03-30.',
    });
  });

  it('flags the same vendor + amount + date even without invoice numbers', () => {
    const flag = checkDuplicate(bill({ invoice_number: null }), [existing({ invoice_number: null })]);
    expect(flag?.reason).toBe('Possible duplicate of a bill from Metro Auto Repair on 2026-03-30.');
  });

  it('returns exactly one flag pointing at the earliest match', () => {
    const flag = checkDuplicate(bill(), [
      existing({ id: 'b2', bill_date: '2026-05-01', invoice_number: 'MAR-002', amount_minor_units: 1 }),
      existing({ id: 'b1', bill_date: '2026-03-30', invoice_number: 'MAR-777' }),
    ]);
    expect(flag?.reason).toContain('invoice MAR-777');
    expect(flag?.reason).toContain('2026-03-30');
  });

  it('does not match when both invoice numbers are null and amount/date differ', () => {
    expect(
      checkDuplicate(bill({ invoice_number: null }), [existing({ invoice_number: null, amount_minor_units: 5 })]),
    ).toBeNull();
  });

  it('does not match another vendor', () => {
    expect(checkDuplicate(bill(), [existing({ vendor_id: 'v-other' })])).toBeNull();
  });
});

describe('checkOvercharge', () => {
  const v = { vendor_name: 'Apex Fuel Co' };

  it('no flag with fewer than 2 paid bills', () => {
    expect(checkOvercharge({ ...v, amount_minor_units: 1_000_000 }, { count: 1, sum: 100 })).toBeNull();
  });

  it('no flag at exactly 2x the average', () => {
    // 3 bills summing 60000 -> threshold amount is 40000
    expect(checkOvercharge({ ...v, amount_minor_units: 40000 }, { count: 3, sum: 60000 })).toBeNull();
  });

  it('flags just above 2x the average, with dollars in the reason', () => {
    expect(checkOvercharge({ ...v, amount_minor_units: 45000 }, { count: 3, sum: 60000 })).toEqual({
      check_name: 'overcharge',
      reason: 'Amount of $450.00 is more than 2x the usual $200.00 average for Apex Fuel Co.',
    });
  });

  it('handles values whose product exceeds Number.MAX_SAFE_INTEGER', () => {
    const flag = checkOvercharge({ ...v, amount_minor_units: 999_999_999 }, { count: 9_007, sum: 9_007 * 400_000_000 });
    expect(flag?.check_name).toBe('overcharge');
  });
});

describe('checkNewPayee', () => {
  it('flags a vendor that was never paid', () => {
    expect(checkNewPayee('v-new', 'Highway Diesel Inc', new Set(['v-apex']))).toEqual({
      check_name: 'new_payee',
      reason: 'First-time payee: Highway Diesel Inc has no payment history.',
    });
  });
  it('no flag for a vendor with paid history', () => {
    expect(checkNewPayee('v-apex', 'Apex Fuel Co', new Set(['v-apex']))).toBeNull();
  });
  it('flags everyone when nothing was ever paid', () => {
    expect(checkNewPayee('v-apex', 'Apex Fuel Co', new Set())).not.toBeNull();
  });
});

describe('checkPolicyLimit', () => {
  it('disabled when the limit is null', () => {
    expect(checkPolicyLimit(999_999_999, null)).toBeNull();
  });
  it('no flag at exactly the limit', () => {
    expect(checkPolicyLimit(100000, 100000)).toBeNull();
  });
  it('no flag below the limit', () => {
    expect(checkPolicyLimit(99999, 100000)).toBeNull();
  });
  it('flags above the limit, with dollars in the reason', () => {
    expect(checkPolicyLimit(125000, 100000)).toEqual({
      check_name: 'policy_limit',
      reason: 'Amount of $1,250.00 is above your per-bill limit of $1,000.00.',
    });
  });
});

// ------------------------------------------- demo scenario (seed data + 8 sample bills)

describe('demo scenario against the seed data', () => {
  const LIMIT = 100000;
  const seedHistory: Record<string, { name: string; amounts: number[] }> = {
    apex: { name: 'Apex Fuel Co', amounts: [22000, 18000, 20000] },
    metro: { name: 'Metro Auto Repair', amounts: [85000, 92000, 78000] },
    proparts: { name: 'ProParts Supply', amounts: [34000, 31000, 36000] },
    driver: { name: 'Driver Direct Ltd', amounts: [15000, 17500, 16000] },
    lube: { name: 'City Lube Station', amounts: [9500, 10500, 8800] },
  };
  const paid = new Set(Object.keys(seedHistory));
  const seedBills: ExistingBill[] = [
    { id: 's-mar-002', vendor_id: 'metro', invoice_number: 'MAR-002', amount_minor_units: 92000, bill_date: '2026-03-30', vendor_name: 'Metro Auto Repair' },
  ];

  const run = (vendorId: string, name: string, amount: number, invoice: string, date: string) => {
    const h = seedHistory[vendorId]?.amounts ?? [];
    return [
      checkDuplicate({ id: 'x', vendor_id: vendorId, invoice_number: invoice, amount_minor_units: amount, bill_date: date }, seedBills),
      checkOvercharge({ amount_minor_units: amount, vendor_name: name }, { count: h.length, sum: h.reduce((a, b) => a + b, 0) }),
      checkNewPayee(vendorId, name, paid),
      checkPolicyLimit(amount, LIMIT),
    ].filter((f) => f !== null).map((f) => f!.check_name);
  };

  it.each([
    ['ready-1 (ProParts $320)', 'proparts', 'ProParts Supply', 32000, 'PPS-104', []],
    ['ready-2 (Driver Direct $160)', 'driver', 'Driver Direct Ltd', 16000, 'DDL-104', []],
    ['ready-3 (City Lube $90)', 'lube', 'City Lube Station', 9000, 'CLS-104', []],
    ['ready-4 (Apex $210)', 'apex', 'Apex Fuel Co', 21000, 'APX-104', []],
    ['duplicate (Metro MAR-002)', 'metro', 'Metro Auto Repair', 92000, 'MAR-002', ['duplicate']],
    ['overcharge (Apex $450)', 'apex', 'Apex Fuel Co', 45000, 'APX-105', ['overcharge']],
    ['new-payee (Highway Diesel $75)', 'highway', 'Highway Diesel Inc', 7500, 'HD-0001', ['new_payee']],
  ] as const)('%s -> %j', (_label, vendorId, name, amount, invoice, expected) => {
    expect(run(vendorId, name, amount, invoice, '2026-11-02')).toEqual(expected);
  });
});

// ------------------------------------------------------- property-based tests

describe('Feature: invoice-processing, Property 1: Duplicate check — no flag when no match exists', () => {
  // Small pools so that collisions are common, then remove every true match.
  const billArb = fc.record({
    id: fc.constantFrom('b1', 'b2', 'b3', 'b4'),
    vendor_id: fc.constantFrom('v1', 'v2', 'v3'),
    invoice_number: fc.option(fc.constantFrom('INV-1', 'INV-2', 'INV-3'), { nil: null }),
    amount_minor_units: fc.integer({ min: 1, max: 5 }),
    bill_date: fc.constantFrom('2026-01-01', '2026-01-02'),
  });
  const existingArb = billArb.map((b) => ({ ...b, vendor_name: `Vendor ${b.vendor_id}` }));
  const isMatch = (b: BillForCheck, e: ExistingBill) =>
    e.id !== b.id &&
    e.vendor_id === b.vendor_id &&
    ((e.invoice_number !== null && e.invoice_number === b.invoice_number) ||
      (e.amount_minor_units === b.amount_minor_units && e.bill_date === b.bill_date));

  it('returns null when no other bill shares vendor+invoice or vendor+amount+date', () => {
    fc.assert(
      fc.property(billArb, fc.array(existingArb, { maxLength: 12 }), (b, list) => {
        const noMatches = list.filter((e) => !isMatch(b, e));
        expect(checkDuplicate(b, noMatches)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('returns a duplicate flag whenever at least one match exists', () => {
    fc.assert(
      fc.property(billArb, fc.array(existingArb, { maxLength: 12 }), (b, list) => {
        fc.pre(list.some((e) => isMatch(b, e)));
        expect(checkDuplicate(b, list)?.check_name).toBe('duplicate');
      }),
      { numRuns: 300 },
    );
  });
});

describe('Feature: invoice-processing, Overcharge properties', () => {
  // count in 2..9007 and per-bill amounts <= 499,999,999 keep every sum safely
  // below Number.MAX_SAFE_INTEGER and keep 2*avg + 1 within the max valid amount.
  const historyArb = fc
    .integer({ min: 2, max: 9_007 })
    .chain((count) =>
      fc.array(fc.integer({ min: 1, max: 499_999_999 }), { minLength: count, maxLength: count }),
    )
    .map((amounts) => ({ count: amounts.length, sum: amounts.reduce((a, b) => a + b, 0) }));

  const threshold = (h: { count: number; sum: number }) => Number((2n * BigInt(h.sum)) / BigInt(h.count));

  it('Property 2: Overcharge check — no flag when below threshold', () => {
    fc.assert(
      fc.property(historyArb, fc.double({ min: 0, max: 1, noNaN: true }), (h, frac) => {
        const amount = Math.min(999_999_999, Math.max(1, Math.floor(threshold(h) * frac)));
        expect(BigInt(amount) * BigInt(h.count) <= 2n * BigInt(h.sum)).toBe(true);
        expect(checkOvercharge({ amount_minor_units: amount, vendor_name: 'v' }, h)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('Property 3: Overcharge check — flag when above threshold', () => {
    fc.assert(
      fc.property(historyArb, fc.integer({ min: 1, max: 1_000_000 }), (h, extra) => {
        const amount = Math.min(999_999_999, threshold(h) + extra);
        expect(BigInt(amount) * BigInt(h.count) > 2n * BigInt(h.sum)).toBe(true);
        expect(checkOvercharge({ amount_minor_units: amount, vendor_name: 'v' }, h)?.check_name).toBe('overcharge');
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: invoice-processing, Property 4: Policy-limit check — correct flag/no-flag based on comparison', () => {
  it('flags if and only if amount > limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1 }), fc.integer({ min: 1 }), (amount, limit) => {
        const flagged = checkPolicyLimit(amount, limit)?.check_name === 'policy_limit';
        expect(flagged).toBe(amount > limit);
      }),
      { numRuns: 500 },
    );
  });
});

describe('Feature: invoice-processing, Property 5: New-payee check — flag iff vendor has no paid history', () => {
  it('flags if and only if the vendor id is absent from the paid set', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.array(fc.uuid(), { maxLength: 20 }), (vendorId, paidIds) => {
        const flagged = checkNewPayee(vendorId, 'v', new Set(paidIds)) !== null;
        expect(flagged).toBe(!paidIds.includes(vendorId));
      }),
      { numRuns: 300 },
    );
  });

  it('never flags a vendor taken from the paid set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 20 }).chain((ids) => fc.tuple(fc.constant(ids), fc.constantFrom(...ids))),
        ([ids, vendorId]) => {
          expect(checkNewPayee(vendorId, 'v', new Set(ids))).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });
});
