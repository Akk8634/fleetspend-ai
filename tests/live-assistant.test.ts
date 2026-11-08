/**
 * Live check of the Payment Assistant's instruction -> criteria step against real Gemini.
 * Uses fixed in-memory bills (no database writes). Skipped by default. Run with:
 *   LIVE_GEMINI=1 npx vitest --run tests/live-assistant.test.ts
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planPayment } from '../lib/assistant/planPayment';
import type { PlanBill } from '../lib/assistant/planEngine';

const live = process.env.LIVE_GEMINI === '1';
if (live && existsSync('.env.local')) process.loadEnvFile('.env.local');

const bills: PlanBill[] = [
  { id: 'apx-104', status: 'ready', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-104', bill_date: '2026-11-04', amount_minor_units: 21000, category: 'fuel', payee_email: 'a@x', flags: [] },
  { id: 'apx-105', status: 'flagged', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-105', bill_date: '2026-11-05', amount_minor_units: 45000, category: 'fuel', payee_email: 'a@x', flags: [{ check_name: 'overcharge', reason: 'x' }] },
  { id: 'cls-104', status: 'ready', vendor_name: 'City Lube Station', invoice_number: 'CLS-104', bill_date: '2026-11-03', amount_minor_units: 9000, category: 'repair', payee_email: 'c@x', flags: [] },
];
const deps = {
  listPayableBills: async () => bills,
  listVendorNames: async () => ['Apex Fuel Co', 'City Lube Station', 'Driver Direct Ltd', 'Metro Auto Repair', 'ProParts Supply'],
  today: '2026-11-08',
};

describe.skipIf(!live)('live Payment Assistant', () => {
  it('"Pay all clean fuel bills from this week" -> fuel, this week, no flagged', async () => {
    const r = await planPayment('Pay all clean fuel bills from this week', deps);
    expect(r.kind).toBe('plan');
    if (r.kind !== 'plan') return;
    expect(r.plan.criteria.categories).toEqual(['fuel']);
    expect(r.plan.criteria.date_from! <= '2026-11-08' && r.plan.criteria.date_to! >= '2026-11-04').toBe(true);
    expect(r.plan.criteria.include_flagged).toBe(false);
    expect(r.plan.included.map((i) => i.billId)).toEqual(['apx-104']);
  }, 60_000);

  it('"Pay all Apex Fuel bills, including flagged ones" -> Apex + flagged', async () => {
    const r = await planPayment('Pay all Apex Fuel bills, including flagged ones', deps);
    expect(r.kind).toBe('plan');
    if (r.kind !== 'plan') return;
    expect(r.plan.criteria.include_flagged).toBe(true);
    expect(r.plan.included.map((i) => i.billId)).toEqual(['apx-104', 'apx-105']);
  }, 60_000);

  it('an unrelated question -> clarify', async () => {
    const r = await planPayment("What's the weather in Pune?", deps);
    expect(r.kind).toBe('clarify');
  }, 60_000);
});
