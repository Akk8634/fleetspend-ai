import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import {
  extractionSchema,
  getLowConfidenceFields,
  GeminiServiceError,
  GeminiTimeoutError,
  ZodValidationError,
} from '../lib/ai/extractionSchema';
import { extractBill, type GenerateFn } from '../lib/ai/extractBill';
import { getPolicyLimitMinorUnits } from '../lib/db/checks';

const good = {
  vendor_name: 'Apex Fuel Co',
  payee_email: 'apex-fuel@example.com',
  amount_text: '450.00',
  currency_code: 'usd',
  bill_date: '2026-11-05',
  invoice_number: 'APX-105',
  category: 'fuel',
  confidence: { vendor_name: 0.99, amount_text: 0.97, currency_code: 0.99, bill_date: 0.95, invoice_number: 0.9 },
};

describe('extractionSchema', () => {
  it('accepts a good response and normalizes currency to upper case', () => {
    const r = extractionSchema.parse(good);
    expect(r.currency_code).toBe('USD');
    expect(r.amount_text).toBe('450.00');
  });

  it('treats empty strings for optional fields as null', () => {
    const r = extractionSchema.parse({ ...good, payee_email: '', invoice_number: '  ' });
    expect(r.payee_email).toBeNull();
    expect(r.invoice_number).toBeNull();
  });

  it('falls back to "other" for an unknown category', () => {
    expect(extractionSchema.parse({ ...good, category: 'snacks' }).category).toBe('other');
  });

  it.each([
    ['missing vendor_name', { vendor_name: undefined }],
    ['empty amount_text', { amount_text: '' }],
    ['bad date format', { bill_date: '05/11/2026' }],
    ['impossible date', { bill_date: '2026-02-30' }],
    ['bad currency', { currency_code: 'US DOLLARS' }],
    ['bad email', { payee_email: 'not-an-email' }],
    ['confidence out of range', { confidence: { ...good.confidence, amount_text: 1.4 } }],
  ])('rejects %s', (_label, patch) => {
    expect(extractionSchema.safeParse({ ...good, ...patch }).success).toBe(false);
  });
});

describe('getLowConfidenceFields', () => {
  it('lists only core fields below 0.8', () => {
    const r = extractionSchema.parse({
      ...good,
      confidence: { vendor_name: 0.95, amount_text: 0.42, currency_code: 0.99, bill_date: 0.79, invoice_number: 0.1, payee_email: 0.2 },
    });
    expect(getLowConfidenceFields(r)).toEqual(['amount_text', 'bill_date']);
  });
  it('is empty when every core field is at least 0.8', () => {
    expect(getLowConfidenceFields(extractionSchema.parse(good))).toEqual([]);
  });
});

describe('extractBill', () => {
  const file = Buffer.from('fake image');
  const fast = { model: 'test-model', timeoutMs: 30, retryDelayMs: 0, sleep: async () => {} };
  const never: GenerateFn = () => new Promise(() => {});

  it('returns validated fields on success', async () => {
    const generate = vi.fn<GenerateFn>(async () => JSON.stringify(good));
    const r = await extractBill(file, 'image/png', { ...fast, generate });
    expect(r.vendor_name).toBe('Apex Fuel Co');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ model: 'test-model', mimeType: 'image/png' });
  });

  it('retries once after a timeout and then succeeds', async () => {
    let calls = 0;
    const generate: GenerateFn = (args) => (++calls === 1 ? never(args) : Promise.resolve(JSON.stringify(good)));
    const sleep = vi.fn(async () => {});
    await expect(extractBill(file, 'image/png', { ...fast, generate, sleep, retryDelayMs: 5000 })).resolves.toBeTruthy();
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('gives up with GeminiTimeoutError after two timeouts', async () => {
    const err = await extractBill(file, 'image/png', { ...fast, generate: never }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiTimeoutError);
    expect(err.message).toBe('AI extraction timed out after 2 attempts.');
  });

  it('retries a 500 once, then reports a service error', async () => {
    const generate = vi.fn<GenerateFn>(async () => { throw new ApiError({ message: 'boom', status: 503 }); });
    const err = await extractBill(file, 'image/png', { ...fast, generate }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiServiceError);
    expect(err.message).toContain('after 2 attempts: HTTP 503');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const generate = vi.fn<GenerateFn>(async () => { throw new ApiError({ message: 'bad', status: 400 }); });
    const err = await extractBill(file, 'image/png', { ...fast, generate }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiServiceError);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not retry invalid JSON and reports it as a validation error', async () => {
    const generate = vi.fn<GenerateFn>(async () => 'not json');
    const err = await extractBill(file, 'image/png', { ...fast, generate }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodValidationError);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('lists every failing field in the validation error', async () => {
    const generate: GenerateFn = async () => JSON.stringify({ ...good, bill_date: 'yesterday', currency_code: 'X' });
    const err = await extractBill(file, 'image/png', { ...fast, generate }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodValidationError);
    expect((err as ZodValidationError).issues.map((i) => i.field).sort()).toEqual(['bill_date', 'currency_code']);
  });

  it('fails clearly when no model is configured', async () => {
    const err = await extractBill(file, 'image/png', { ...fast, model: '', generate: never }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiServiceError);
  });
});

describe('getPolicyLimitMinorUnits', () => {
  it('reads a positive integer', () => {
    expect(getPolicyLimitMinorUnits({ POLICY_LIMIT_MINOR_UNITS: '100000' })).toBe(100000);
  });
  it.each([undefined, '', '0', '-5', '12.5', 'abc'])('disables the check for %j', (v) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getPolicyLimitMinorUnits({ POLICY_LIMIT_MINOR_UNITS: v })).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
