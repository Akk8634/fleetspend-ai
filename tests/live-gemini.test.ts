/**
 * Live check against the real Gemini API using the 8 sample bills.
 * Skipped by default (it costs API quota). Run with:
 *   LIVE_GEMINI=1 npx vitest --run tests/live-gemini.test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractBill } from '../lib/ai/extractBill';
import { getLowConfidenceFields } from '../lib/ai/extractionSchema';
import { parseAmountText } from '../lib/money/parseAmountText';
import { normalizeVendorName } from '../lib/vendors/normalizeVendorName';

const live = process.env.LIVE_GEMINI === '1';
if (live && existsSync('.env.local')) process.loadEnvFile('.env.local');

const cases = [
  { file: 'ready-1.jpg', vendor: 'proparts supply', cents: 32000, invoice: 'PPS-104', date: '2026-11-02' },
  { file: 'ready-2.jpg', vendor: 'driver direct', cents: 16000, invoice: 'DDL-104', date: '2026-11-03' },
  { file: 'ready-3.jpg', vendor: 'city lube station', cents: 9000, invoice: 'CLS-104', date: '2026-11-03' },
  { file: 'ready-4.jpg', vendor: 'apex fuel', cents: 21000, invoice: 'APX-104', date: '2026-11-04' },
  { file: 'duplicate.jpg', vendor: 'metro auto repair', cents: 92000, invoice: 'MAR-002', date: '2026-03-30' },
  { file: 'overcharge.jpg', vendor: 'apex fuel', cents: 45000, invoice: 'APX-105', date: '2026-11-05' },
  { file: 'new-payee.jpg', vendor: 'highway diesel', cents: 7500, invoice: 'HD-0001', date: '2026-11-05' },
];

describe.skipIf(!live)('live Gemini extraction on sample bills', () => {
  for (const c of cases) {
    it(`${c.file} is read correctly with high confidence`, async () => {
      const started = Date.now();
      const r = await extractBill(readFileSync(`public/samples/${c.file}`), 'image/jpeg');
      const ms = Date.now() - started;
      console.log(`${c.file}: ${ms} ms`, JSON.stringify({ ...r, confidence: undefined }), JSON.stringify(r.confidence));

      expect(normalizeVendorName(r.vendor_name)).toBe(c.vendor);
      expect(parseAmountText(r.amount_text, r.currency_code)).toBe(c.cents);
      expect(r.currency_code).toBe('USD');
      expect(r.invoice_number).toBe(c.invoice);
      expect(r.bill_date).toBe(c.date);
      expect(r.payee_email).toBeTruthy();
      expect(getLowConfidenceFields(r)).toEqual([]);
    }, 60_000);
  }

  it('needs-review.jpg comes back with low confidence on at least one core field', async () => {
    const started = Date.now();
    let outcome: string;
    try {
      const r = await extractBill(readFileSync('public/samples/needs-review.jpg'), 'image/jpeg');
      outcome = `low=${JSON.stringify(getLowConfidenceFields(r))} ${JSON.stringify(r)}`;
      expect(getLowConfidenceFields(r).length).toBeGreaterThan(0);
    } catch (e) {
      // A validation failure (e.g. unreadable date) also lands the bill in needs_review.
      outcome = `error: ${(e as Error).message}`;
      expect((e as Error).name).toBe('ZodValidationError');
    }
    console.log(`needs-review.jpg: ${Date.now() - started} ms`, outcome);
  }, 60_000);
});
