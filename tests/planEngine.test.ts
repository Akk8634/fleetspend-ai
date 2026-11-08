import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildPlan, describeCriteria, PLAN_CAP_CENTS, type PlanBill } from '../lib/assistant/planEngine';

it('plan cap is $5,000', () => expect(PLAN_CAP_CENTS).toBe(500_000));
import { planCriteriaSchema, type PlanCriteria } from '../lib/assistant/criteriaSchema';
import { normalizeVendorName } from '../lib/vendors/normalizeVendorName';
import type { BillStatus } from '../lib/db/types';

const criteria = (over: Partial<PlanCriteria> = {}): PlanCriteria =>
  planCriteriaSchema.parse({ intent: 'plan', include_flagged: false, include_failed: false, summary: 's', ...over });

// ------------------------------------------------------------ demo examples

const demoBills: PlanBill[] = [
  { id: 'b1', status: 'ready', vendor_name: 'ProParts Supply', invoice_number: 'PPS-104', bill_date: '2026-11-02', amount_minor_units: 32000, category: 'parts', payee_email: 'p@x', flags: [] },
  { id: 'b2', status: 'ready', vendor_name: 'Driver Direct Ltd', invoice_number: 'DDL-104', bill_date: '2026-11-03', amount_minor_units: 16000, category: 'driver_trip', payee_email: 'd@x', flags: [] },
  { id: 'b3', status: 'ready', vendor_name: 'City Lube Station', invoice_number: 'CLS-104', bill_date: '2026-11-03', amount_minor_units: 9000, category: 'repair', payee_email: 'c@x', flags: [] },
  { id: 'b4', status: 'ready', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-104', bill_date: '2026-11-04', amount_minor_units: 21000, category: 'fuel', payee_email: 'a@x', flags: [] },
  { id: 'b5', status: 'flagged', vendor_name: 'Metro Auto Repair', invoice_number: 'MAR-002', bill_date: '2026-03-30', amount_minor_units: 92000, category: 'repair', payee_email: 'm@x', flags: [{ check_name: 'duplicate', reason: 'dup' }] },
  { id: 'b6', status: 'flagged', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-105', bill_date: '2026-11-05', amount_minor_units: 45000, category: 'fuel', payee_email: 'a@x', flags: [{ check_name: 'overcharge', reason: 'over' }] },
  { id: 'b7', status: 'flagged', vendor_name: 'Highway Diesel Inc', invoice_number: 'HD-0001', bill_date: '2026-11-05', amount_minor_units: 7500, category: 'fuel', payee_email: 'h@x', flags: [{ check_name: 'new_payee', reason: 'new' }] },
  { id: 'b8', status: 'paid', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-099', bill_date: '2026-11-03', amount_minor_units: 1000, category: 'fuel', payee_email: 'a@x', flags: [] },
];

describe('buildPlan on the demo bills', () => {
  it('"clean fuel bills this week" -> only the ready Apex bill; flagged fuel bills listed as excluded', () => {
    const plan = buildPlan(demoBills, criteria({ categories: ['fuel'], date_from: '2026-11-02', date_to: '2026-11-08' }));
    expect(plan.included.map((i) => i.billId)).toEqual(['b4']);
    expect(plan.included[0].reason).toBe('Fuel · Nov 4 · passed all checks');
    expect(plan.excluded.map((e) => e.billId).sort()).toEqual(['b6', 'b7']);
    expect(plan.excluded.find((e) => e.billId === 'b6')!.reason).toMatch(/^Flagged: overcharge/);
    expect(plan.totalCents).toBe(21000);
  });

  it('"everything from Apex including flagged" -> both Apex bills, oldest first, never the paid one', () => {
    const plan = buildPlan(demoBills, criteria({ vendor_names: ['Apex Fuel'], include_flagged: true }));
    expect(plan.included.map((i) => i.billId)).toEqual(['b4', 'b6']);
    expect(plan.included[1].reason).toContain('you asked to include flagged bills');
    expect(plan.payeeCount).toBe(1);
  });

  it('"pay everything under $200 up to $250 total" -> per-bill and total limits applied, oldest first', () => {
    const plan = buildPlan(demoBills, criteria({ max_amount_per_bill: '200.00', max_total: '250.00' }));
    expect(plan.included.map((i) => i.billId)).toEqual(['b3', 'b2']); // Nov 3: $90 then $160 = $250
    expect(plan.totalCents).toBe(25000);
    expect(plan.limitCents).toBe(25000);
  });

  it('excludes over-limit bills with a reason', () => {
    const plan = buildPlan(demoBills, criteria({ max_total: '300.00' }));
    expect(plan.excluded.some((e) => e.reason === 'Would exceed the plan limit of $300.00')).toBe(true);
  });

  it('describes the criteria as readable chips', () => {
    expect(describeCriteria(criteria({ categories: ['fuel'], date_from: '2026-11-02', date_to: '2026-11-08', max_total: '1000' })))
      .toEqual(['Fuel', 'Nov 2, 2026 – Nov 8, 2026', 'Total ≤ $1,000.00', 'Clean bills only']);
  });
});

// ------------------------------------------------------------ properties

const statusArb = fc.constantFrom<BillStatus>('uploaded', 'extracted', 'needs_review', 'ready', 'flagged', 'payout_pending', 'paid', 'payout_failed');
const dateArb = fc.integer({ min: 0, max: 60 }).map((d) => new Date(Date.UTC(2026, 9, 1) + d * 86_400_000).toISOString().slice(0, 10));
const vendorArb = fc.constantFrom('Apex Fuel Co', 'Metro Auto Repair', 'ProParts Supply', 'City Lube Station', 'Highway Diesel Inc');
const billArb = fc.record({
  id: fc.uuid(),
  status: statusArb,
  vendor_name: vendorArb,
  invoice_number: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  bill_date: fc.option(dateArb, { nil: null }),
  amount_minor_units: fc.option(fc.integer({ min: 1, max: 300_000 }), { nil: null }),
  category: fc.option(fc.constantFrom('fuel', 'repair', 'parts', 'driver_trip', 'other'), { nil: null }),
  payee_email: fc.option(fc.constantFrom('a@x', 'b@x', 'c@x'), { nil: null }),
  flags: fc.constant([]),
}) as fc.Arbitrary<PlanBill>;
const billsArb = fc.uniqueArray(billArb, { maxLength: 40, selector: (b) => b.id });
const money = fc.option(fc.integer({ min: 1, max: 900_000 }).map((c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`), { nil: null });
const criteriaArb = fc.record({
  vendor_names: fc.uniqueArray(vendorArb, { maxLength: 2 }),
  categories: fc.uniqueArray(fc.constantFrom('fuel', 'repair', 'parts', 'driver_trip', 'other') as fc.Arbitrary<'fuel'>, { maxLength: 2 }),
  date_from: fc.option(dateArb, { nil: null }),
  date_to: fc.option(dateArb, { nil: null }),
  max_amount_per_bill: money,
  max_total: money,
  include_flagged: fc.boolean(),
  include_failed: fc.boolean(),
}).map((c) => criteria(c));
const cents = (s: string | null | undefined) => (s ? Math.round(Number(s) * 100) : null); // test-side only

describe('Feature: approval-agent, Property 11: Plans only contain safe, matching, payable bills', () => {
  it('every included bill is payable, complete and matches every criterion', () => {
    fc.assert(
      fc.property(billsArb, criteriaArb, (bills, c) => {
        const plan = buildPlan(bills, c);
        const byId = new Map(bills.map((b) => [b.id, b]));
        for (const entry of plan.included) {
          const b = byId.get(entry.billId)!;
          expect(['ready', 'flagged', 'payout_failed']).toContain(b.status);
          expect(b.status !== 'flagged' || c.include_flagged).toBe(true);
          expect(b.status !== 'payout_failed' || c.include_failed).toBe(true);
          expect(b.payee_email && b.amount_minor_units && b.bill_date).toBeTruthy();
          if (c.categories.length) expect(c.categories).toContain(b.category);
          if (c.date_from) expect(b.bill_date! >= c.date_from).toBe(true);
          if (c.date_to) expect(b.bill_date! <= c.date_to).toBe(true);
          const per = cents(c.max_amount_per_bill);
          if (per !== null) expect(b.amount_minor_units!).toBeLessThanOrEqual(per);
          if (c.vendor_names.length) {
            expect(c.vendor_names.some((v) => normalizeVendorName(b.vendor_name!).includes(normalizeVendorName(v)) || normalizeVendorName(v).includes(normalizeVendorName(b.vendor_name!)))).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('Feature: approval-agent, Property 12: Plan totals are exact and capped', () => {
  it('total = sum of included amounts and never exceeds min(max_total, plan cap)', () => {
    fc.assert(
      fc.property(billsArb, criteriaArb, fc.integer({ min: 1, max: 1_000_000 }), (bills, c, cap) => {
        const plan = buildPlan(bills, c, { planCapCents: cap });
        expect(plan.totalCents).toBe(plan.included.reduce((s, i) => s + i.amountCents, 0));
        const limit = Math.min(cents(c.max_total) ?? Infinity, cap);
        expect(plan.totalCents).toBeLessThanOrEqual(limit);
        expect(new Set(plan.included.map((i) => i.billId)).size).toBe(plan.included.length);
      }),
      { numRuns: 300 },
    );
  });
});

describe('Feature: approval-agent, Property 13: Plans are deterministic', () => {
  it('any permutation of the input bills gives the same plan', () => {
    fc.assert(
      fc.property(billsArb.chain((bills) => fc.tuple(fc.constant(bills), fc.shuffledSubarray(bills, { minLength: bills.length, maxLength: bills.length }))), criteriaArb, ([bills, shuffled], c) => {
        const a = buildPlan(bills, c);
        const b = buildPlan(shuffled, c);
        expect(b.included.map((i) => i.billId)).toEqual(a.included.map((i) => i.billId));
        expect(b.totalCents).toBe(a.totalCents);
        expect(b.excluded.map((e) => e.billId).sort()).toEqual(a.excluded.map((e) => e.billId).sort());
      }),
      { numRuns: 300 },
    );
  });
});
