/**
 * Live PayPal sandbox check: pays ONE $1.00 bill end to end and waits for PayPal to confirm.
 * Writes to the real Supabase project (one test bill + one payout). Skipped by default. Run with:
 *   LIVE_PAYPAL=1 npx vitest --run tests/live-paypal.test.ts
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createServerClient } from '../lib/db/client';
import { approveAndPay, syncBatch } from '../lib/payments/approveAndPay';
import { createSupabasePaymentStore } from '../lib/payments/store';
import { createPayPalClient } from '../lib/paypal/client';
import { getPayPalConfig } from '../lib/paypal/config';

const live = process.env.LIVE_PAYPAL === '1';
if (live && existsSync('.env.local')) process.loadEnvFile('.env.local');

describe.skipIf(!live)('live PayPal sandbox payout', () => {
  it('pays a $1.00 bill and marks it paid with a PayPal transaction id', async () => {
    const config = getPayPalConfig();
    expect(config, 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET must be set').not.toBeNull();
    const supabase = createServerClient();
    const deps = { store: createSupabasePaymentStore(supabase), paypal: createPayPalClient({ config: config! }) };

    // A ready $1.00 bill for a seeded vendor (sandbox payee email).
    const { data: vendor } = await supabase.from('vendors').select('id, name, paypal_email').eq('normalized_name', 'apex fuel').single();
    const { data: bill, error } = await supabase
      .from('bills')
      .insert({
        vendor_id: vendor!.id, storage_path: 'live-test/none', original_filename: 'live-paypal-test.txt', status: 'ready',
        vendor_name_raw: vendor!.name, amount_text: '1.00', amount_minor_units: 100, currency_code: 'USD',
        bill_date: new Date().toISOString().slice(0, 10), invoice_number: `LIVE-${Date.now()}`, payee_email: vendor!.paypal_email,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    let batch = await approveAndPay({ billIds: [bill!.id] }, deps);
    console.log('created batch', batch.id, 'paypal', batch.paypal_batch_id, batch.status, batch.error_message ?? '');
    expect(batch.status).not.toBe('failed');

    for (let i = 0; i < 12 && !batch.finished; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      batch = await syncBatch(batch.id, deps);
      console.log(`sync ${i + 1}:`, batch.status, batch.items.map((x) => `${x.outcome}/${x.transaction_status}`).join(','));
    }

    const { data: after } = await supabase.from('bills').select('status').eq('id', bill!.id).single();
    expect(batch.items[0].outcome).toBe('success');
    expect(batch.items[0].transaction_id).toBeTruthy();
    expect(after!.status).toBe('paid');
  }, 120_000);
});
