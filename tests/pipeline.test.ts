import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Flag } from '../lib/checks/types';
import type { BillWithDetails, Vendor } from '../lib/db/types';
import { BillNotFoundError } from '../lib/db/bills';
import { GeminiTimeoutError, type Extraction } from '../lib/ai/extractionSchema';
import { INTERNAL_ERROR_MESSAGE, processBill, USD_ONLY_MESSAGE } from '../lib/pipeline/processBill';
import { BillNotReviewableError, correctBill, CorrectionValidationError } from '../lib/pipeline/correctBill';
import type { Corrections, ExtractionFields, PipelineStore } from '../lib/pipeline/store';
import { normalizeVendorName } from '../lib/vendors/normalizeVendorName';
import { safeFileName, validateBatch, validateFile } from '../lib/uploads/validateUpload';

// ------------------------------------------------------------ in-memory store

class FakeStore implements PipelineStore {
  bills = new Map<string, BillWithDetails>();
  vendors = new Map<string, Vendor>();
  corrections: Corrections[] = [];
  failDownload = false;
  private seq = 0;

  addVendor(name: string, email: string | null = null): Vendor {
    const v: Vendor = { id: `v${++this.seq}`, name, normalized_name: normalizeVendorName(name), paypal_email: email, category: null, created_at: '' };
    this.vendors.set(v.id, v);
    return v;
  }

  addBill(over: Partial<BillWithDetails>): BillWithDetails {
    const b: BillWithDetails = {
      id: `b${++this.seq}`, vendor_id: null, storage_path: 'x/bill.jpg', original_filename: 'bill.jpg', status: 'uploaded',
      vendor_name_raw: null, amount_text: null, amount_minor_units: null, currency_code: null, bill_date: null,
      invoice_number: null, payee_email: null, category: null, confidence: null, low_confidence_fields: null,
      review_message: null, is_seed: false, created_at: '', updated_at: '', vendor_name: null, flags: [], payout: null, ...over,
    };
    this.bills.set(b.id, b);
    return b;
  }

  private need(id: string) {
    const b = this.bills.get(id);
    if (!b) throw new BillNotFoundError(id);
    return b;
  }

  async getBill(id: string) {
    const b = this.need(id);
    const vendor = b.vendor_id ? this.vendors.get(b.vendor_id) : undefined;
    return { ...b, vendor_name: vendor?.name ?? b.vendor_name_raw, flags: [...b.flags] };
  }
  async downloadBillFile() {
    if (this.failDownload) throw new Error('storage down');
    return { buffer: Buffer.from('img'), mimeType: 'image/jpeg' };
  }
  async saveExtraction(a: { billId: string; fields: ExtractionFields; vendorId: string | null; status: 'extracted' | 'needs_review'; lowConfidenceFields: string[]; message: string | null }) {
    const b = this.need(a.billId);
    if (b.status !== 'uploaded') throw new Error(`save_extraction requires status=uploaded, got ${b.status}`);
    Object.assign(b, {
      vendor_id: a.vendorId, vendor_name_raw: a.fields.vendor_name ?? null, amount_text: a.fields.amount_text ?? null,
      amount_minor_units: a.fields.amount_minor_units ?? null, currency_code: a.fields.currency_code ?? null,
      bill_date: a.fields.bill_date ?? null, invoice_number: a.fields.invoice_number ?? null,
      payee_email: a.fields.payee_email ?? null, low_confidence_fields: a.lowConfidenceFields,
      review_message: a.message, status: a.status,
    });
  }
  async findVendorByNormalizedName(n: string) {
    return [...this.vendors.values()].find((v) => v.normalized_name === n) ?? null;
  }
  async getVendor(id: string) { return this.vendors.get(id) ?? null; }
  async matchOrCreateVendor(name: string) {
    const found = await this.findVendorByNormalizedName(normalizeVendorName(name));
    return found ? { vendorId: found.id, created: false } : { vendorId: this.addVendor(name).id, created: true };
  }
  async setVendorEmailIfMissing(id: string, email: string) {
    const v = this.vendors.get(id)!;
    v.paypal_email ??= email;
  }
  async getBillsForDuplicateCheck(vendorId: string) {
    return [...this.bills.values()]
      .filter((b) => b.vendor_id === vendorId && !['uploaded', 'needs_review'].includes(b.status) && b.amount_minor_units !== null)
      .map((b) => ({ id: b.id, vendor_id: vendorId, invoice_number: b.invoice_number, amount_minor_units: b.amount_minor_units!, bill_date: b.bill_date!, vendor_name: this.vendors.get(vendorId)!.name }));
  }
  async getOverchargeHistory(vendorId: string, currency: string) {
    const paid = [...this.bills.values()].filter((b) => b.vendor_id === vendorId && b.currency_code === currency && b.status === 'paid');
    return { count: paid.length, sum: paid.reduce((s, b) => s + b.amount_minor_units!, 0) };
  }
  async getPaidVendorIds() {
    return new Set([...this.bills.values()].filter((b) => b.status === 'paid').map((b) => b.vendor_id!));
  }
  async completeChecks(id: string, flags: Flag[]) {
    const b = this.need(id);
    if (!['extracted', 'needs_review'].includes(b.status)) throw new Error('complete_checks requires extracted or needs_review');
    b.flags = flags;
    b.status = flags.length ? 'flagged' : 'ready';
    b.review_message = null;
  }
  async saveCorrections(id: string, c: Corrections) {
    const b = this.need(id);
    if (b.status !== 'needs_review') throw new Error('save_field_corrections requires needs_review');
    this.corrections.push(c);
    Object.assign(b, {
      vendor_name_raw: c.vendor_name_raw ?? b.vendor_name_raw, vendor_id: c.vendor_id ?? b.vendor_id,
      amount_text: c.amount_text ?? b.amount_text, amount_minor_units: c.amount_minor_units ?? b.amount_minor_units,
      currency_code: c.currency_code ?? b.currency_code, bill_date: c.bill_date ?? b.bill_date,
      invoice_number: c.invoice_number ?? b.invoice_number, payee_email: c.payee_email ?? b.payee_email,
    });
  }
}

// ------------------------------------------------------------ seed + helpers

let store: FakeStore;
let apex: Vendor;
let metro: Vendor;
const LIMIT = 100000;

beforeEach(() => {
  store = new FakeStore();
  apex = store.addVendor('Apex Fuel Co', 'apex-fuel@example.com');
  metro = store.addVendor('Metro Auto Repair', 'metro-repair@example.com');
  for (const [cents, inv, date] of [[22000, 'APX-001', '2025-11-10'], [18000, 'APX-002', '2026-02-05'], [20000, 'APX-003', '2026-06-15']] as const) {
    store.addBill({ status: 'paid', is_seed: true, vendor_id: apex.id, amount_minor_units: cents, currency_code: 'USD', invoice_number: inv, bill_date: date });
  }
  for (const [cents, inv, date] of [[85000, 'MAR-001', '2025-11-20'], [92000, 'MAR-002', '2026-03-30'], [78000, 'MAR-003', '2026-08-01']] as const) {
    store.addBill({ status: 'paid', is_seed: true, vendor_id: metro.id, amount_minor_units: cents, currency_code: 'USD', invoice_number: inv, bill_date: date });
  }
});

const sure = { vendor_name: 0.99, amount_text: 0.99, currency_code: 0.99, bill_date: 0.99 };
const extraction = (over: Partial<Extraction> = {}): Extraction => ({
  vendor_name: 'Apex Fuel Company', payee_email: null, amount_text: '210.00', currency_code: 'USD',
  bill_date: '2026-11-04', invoice_number: 'APX-104', category: 'fuel', confidence: sure, ...over,
});
const run = (billId: string, ex: Extraction | Error) =>
  processBill(billId, {
    store,
    policyLimit: LIMIT,
    extract: vi.fn(async () => { if (ex instanceof Error) throw ex; return ex; }),
  });

// ------------------------------------------------------------ processBill

describe('processBill', () => {
  it('known vendor, normal amount -> ready, matched to the existing vendor despite spelling', async () => {
    const bill = store.addBill({});
    const r = await run(bill.id, extraction());
    expect(r).toMatchObject({ status: 'ready', flags: [] });
    const saved = store.bills.get(bill.id)!;
    expect(saved.vendor_id).toBe(apex.id);
    expect(saved.amount_minor_units).toBe(21000);
    expect(saved.payee_email).toBe('apex-fuel@example.com'); // fallback to the vendor's email
  });

  it('$450 from Apex -> flagged overcharge', async () => {
    const r = await run(store.addBill({}).id, extraction({ amount_text: '450.00', invoice_number: 'APX-105' }));
    expect(r.status).toBe('flagged');
    expect(r.flags.map((f) => f.check_name)).toEqual(['overcharge']);
    expect(r.flags[0].reason).toBe('Amount of $450.00 is more than 2x the usual $200.00 average for Apex Fuel Co.');
  });

  it('copy of MAR-002 -> flagged duplicate', async () => {
    const r = await run(store.addBill({}).id, extraction({ vendor_name: 'Metro Auto Repair', amount_text: '920.00', invoice_number: 'MAR-002', bill_date: '2026-03-30' }));
    expect(r.flags.map((f) => f.check_name)).toEqual(['duplicate']);
  });

  it('unknown vendor -> new vendor created with the printed email, flagged new_payee', async () => {
    const r = await run(store.addBill({}).id, extraction({ vendor_name: 'Highway Diesel Inc', payee_email: 'pay@hd.example.com', amount_text: '75.00', invoice_number: 'HD-0001' }));
    expect(r.flags.map((f) => f.check_name)).toEqual(['new_payee']);
    const created = await store.findVendorByNormalizedName('highway diesel');
    expect(created?.paypal_email).toBe('pay@hd.example.com');
  });

  it('a duplicate inside the same batch is caught once the first copy is processed', async () => {
    const first = await run(store.addBill({}).id, extraction({ invoice_number: 'APX-200' }));
    const second = await run(store.addBill({}).id, extraction({ invoice_number: 'APX-200' }));
    expect(first.status).toBe('ready');
    expect(second.flags.map((f) => f.check_name)).toEqual(['duplicate']);
  });

  it('above the policy limit -> policy_limit flag', async () => {
    const r = await run(store.addBill({}).id, extraction({ vendor_name: 'Metro Auto Repair', amount_text: '1,250.00', invoice_number: 'MAR-900' }));
    expect(r.flags.map((f) => f.check_name)).toEqual(['policy_limit']);
  });

  it('Gemini timeout -> needs_review with the timeout message and no fields', async () => {
    const bill = store.addBill({});
    const r = await run(bill.id, new GeminiTimeoutError(2));
    expect(r).toMatchObject({ status: 'needs_review', error: 'AI extraction timed out after 2 attempts.' });
    expect(store.bills.get(bill.id)!.vendor_name_raw).toBeNull();
  });

  it('non-USD -> needs_review with the USD message and fields kept for the form', async () => {
    const bill = store.addBill({});
    const r = await run(bill.id, extraction({ currency_code: 'EUR' }));
    expect(r).toMatchObject({ status: 'needs_review', error: USD_ONLY_MESSAGE });
    expect(store.bills.get(bill.id)!.amount_text).toBe('210.00');
  });

  it('low confidence -> needs_review listing the unsure fields, vendor pre-selected but not created', async () => {
    const bill = store.addBill({});
    const vendorsBefore = store.vendors.size;
    const r = await run(bill.id, extraction({ confidence: { ...sure, amount_text: 0.6, bill_date: 0.5 } }));
    expect(r.status).toBe('needs_review');
    expect(r.lowConfidenceFields).toEqual(['amount_text', 'bill_date']);
    expect(r.error).toBe('The AI was not sure about: amount, date. Please check these fields.');
    expect(store.bills.get(bill.id)!.vendor_id).toBe(apex.id);
    expect(store.vendors.size).toBe(vendorsBefore);
  });

  it('unreadable amount text -> needs_review asking for the amount', async () => {
    const r = await run(store.addBill({}).id, extraction({ amount_text: 'about two hundred' }));
    expect(r).toMatchObject({ status: 'needs_review', lowConfidenceFields: ['amount_text'] });
  });

  it('is idempotent: an already processed bill is returned without calling Gemini again', async () => {
    const bill = store.addBill({});
    await run(bill.id, extraction());
    const extract = vi.fn();
    const r = await processBill(bill.id, { store, policyLimit: LIMIT, extract });
    expect(r).toMatchObject({ status: 'ready', skipped: true });
    expect(extract).not.toHaveBeenCalled();
  });

  it('resumes an interrupted bill that is stuck in extracted', async () => {
    const bill = store.addBill({ status: 'extracted', vendor_id: apex.id, amount_minor_units: 21000, currency_code: 'USD', bill_date: '2026-11-04', invoice_number: 'APX-104' });
    const extract = vi.fn();
    const r = await processBill(bill.id, { store, policyLimit: LIMIT, extract });
    expect(r.status).toBe('ready');
    expect(extract).not.toHaveBeenCalled();
  });

  it('an unexpected failure parks the bill in needs_review instead of crashing the batch', async () => {
    store.failDownload = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run(store.addBill({}).id, extraction());
    spy.mockRestore();
    expect(r).toMatchObject({ status: 'needs_review', error: INTERNAL_ERROR_MESSAGE });
  });

  it('throws BillNotFoundError for an unknown id', async () => {
    await expect(run('nope', extraction())).rejects.toBeInstanceOf(BillNotFoundError);
  });
});

// ------------------------------------------------------------ correctBill

describe('correctBill', () => {
  const form = { vendor_name: 'Metro Auto Repair', currency_code: 'usd', amount: '1,250.50', bill_date: '2026-11-07', invoice_number: '', payee_email: '' };

  const reviewBill = async () => {
    const bill = store.addBill({});
    await run(bill.id, extraction({ vendor_name: 'Metro Auto Repair', confidence: { ...sure, amount_text: 0.5 } }));
    return bill;
  };

  it('saves corrections with cents and runs the checks', async () => {
    const bill = await reviewBill();
    const r = await correctBill(bill.id, form, { store, policyLimit: LIMIT });
    expect(r.flags.map((f) => f.check_name)).toEqual(['policy_limit']);
    expect(store.corrections[0]).toMatchObject({ vendor_id: metro.id, amount_minor_units: 125050, currency_code: 'USD', amount_text: '1,250.50', payee_email: 'metro-repair@example.com' });
  });

  it('rejects invalid input with one message per field and writes nothing', async () => {
    const bill = await reviewBill();
    const err = await correctBill(bill.id, { ...form, vendor_name: ' ', amount: '12.345', currency_code: 'EUR', bill_date: '2026-02-30' }, { store, policyLimit: LIMIT }).catch((e) => e);
    expect(err).toBeInstanceOf(CorrectionValidationError);
    expect(Object.keys(err.fieldErrors).sort()).toEqual(['amount', 'bill_date', 'currency_code', 'vendor_name']);
    expect(err.fieldErrors.currency_code).toBe(USD_ONLY_MESSAGE);
    expect(store.corrections).toHaveLength(0);
    expect(store.bills.get(bill.id)!.status).toBe('needs_review');
  });

  it('refuses to correct a bill that is not in needs_review', async () => {
    const bill = store.addBill({});
    await run(bill.id, extraction());
    await expect(correctBill(bill.id, form, { store, policyLimit: LIMIT })).rejects.toBeInstanceOf(BillNotReviewableError);
  });

  it('rejects an unknown picked vendor id', async () => {
    const bill = await reviewBill();
    const err = await correctBill(bill.id, { ...form, vendor_id: '00000000-0000-4000-8000-000000000000' }, { store, policyLimit: LIMIT }).catch((e) => e);
    expect(err.fieldErrors).toEqual({ vendor_id: 'Unknown vendor' });
  });

  it('creates a new vendor when the owner types a new name', async () => {
    const bill = await reviewBill();
    const r = await correctBill(bill.id, { ...form, vendor_name: 'Roadside Rescue LLC', amount: '80', payee_email: 'help@rr.example.com' }, { store, policyLimit: LIMIT });
    expect(r.flags.map((f) => f.check_name)).toEqual(['new_payee']);
    expect((await store.findVendorByNormalizedName('roadside rescue'))?.paypal_email).toBe('help@rr.example.com');
  });
});

// ------------------------------------------------------------ upload validation

describe('upload validation', () => {
  it('accepts JPG, PNG and PDF up to 10 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'application/pdf']) {
      expect(validateFile({ name: 'a', type, size: 10 * 1024 * 1024 })).toBeNull();
    }
  });
  it('rejects other types, empty files and files over 10 MB, naming the file', () => {
    expect(validateFile({ name: 'x.gif', type: 'image/gif', size: 5 })).toContain('x.gif: unsupported file type image/gif');
    expect(validateFile({ name: 'e.png', type: 'image/png', size: 0 })).toContain('empty');
    expect(validateFile({ name: 'big.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 })).toContain('big.pdf: 10.0 MB');
  });
  it('limits a batch to 20 files and 100 MB', () => {
    expect(validateBatch([])).toBe('No files were uploaded.');
    expect(validateBatch(Array.from({ length: 21 }, () => ({ size: 1 })))).toContain('at most 20');
    expect(validateBatch(Array.from({ length: 11 }, () => ({ size: 10 * 1024 * 1024 })))).toContain('limit is 100.0 MB');
    expect(validateBatch([{ size: 1 }])).toBeNull();
  });
  it('makes storage-safe file names', () => {
    expect(safeFileName('My Bill (Nov) #3.jpg')).toBe('My_Bill_Nov_3.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('???')).toBe('bill');
  });
});
