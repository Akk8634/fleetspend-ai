/**
 * Read-only live check of lib/db against the real Supabase project and its seed data.
 * Skipped by default. Run with:
 *   LIVE_SUPABASE=1 npx vitest --run tests/live-supabase.test.ts
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createServerClient } from '../lib/db/client';
import { getBillsForDuplicateCheck, getOverchargeHistory, getPaidVendorIds, listUserBills } from '../lib/db/bills';
import { getVendorByNormalizedName, listVendors } from '../lib/db/vendors';
import { checkDuplicate } from '../lib/checks/checkDuplicate';
import { checkOvercharge } from '../lib/checks/checkOvercharge';

const live = process.env.LIVE_SUPABASE === '1';
if (live && existsSync('.env.local')) process.loadEnvFile('.env.local');

describe.skipIf(!live)('live Supabase reads (seed data)', () => {
  it('lists the 5 seeded vendors', async () => {
    const vendors = await listVendors(createServerClient());
    expect(vendors.map((v) => v.normalized_name).sort()).toEqual(
      ['apex fuel', 'city lube station', 'driver direct', 'metro auto repair', 'proparts supply'],
    );
  });

  it('has payment history for all 5 seeded vendors', async () => {
    expect((await getPaidVendorIds(createServerClient())).size).toBeGreaterThanOrEqual(5);
  });

  it('gives Apex Fuel 3 paid bills totalling $600 and flags a $450 bill as overcharge', async () => {
    const db = createServerClient();
    const apex = await getVendorByNormalizedName('apex fuel', db);
    const history = await getOverchargeHistory(apex!.id, 'USD', db);
    expect(history).toEqual({ count: 3, sum: 60000 });
    expect(checkOvercharge({ amount_minor_units: 45000, vendor_name: apex!.name }, history)?.check_name).toBe('overcharge');
  });

  it('finds seeded MAR-002 and flags a copy of it as a duplicate', async () => {
    const db = createServerClient();
    const metro = await getVendorByNormalizedName('metro auto repair', db);
    const existing = await getBillsForDuplicateCheck(metro!.id, db);
    expect(existing).toHaveLength(3);
    expect(existing[0].vendor_name).toBe('Metro Auto Repair');
    const flag = checkDuplicate(
      { id: 'new', vendor_id: metro!.id, invoice_number: 'MAR-002', amount_minor_units: 92000, bill_date: '2026-03-30' },
      existing,
    );
    expect(flag?.reason).toBe('Possible duplicate of invoice MAR-002 from Metro Auto Repair on 2026-03-30.');
  });

  it('lists user bills without seed bills', async () => {
    const bills = await listUserBills(createServerClient());
    expect(bills.every((b) => !b.is_seed)).toBe(true);
  });
});
