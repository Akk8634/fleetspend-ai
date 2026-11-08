import { extractBill as realExtractBill } from '../ai/extractBill';
import {
  GeminiServiceError,
  GeminiTimeoutError,
  getLowConfidenceFields,
  ZodValidationError,
  type Extraction,
} from '../ai/extractionSchema';
import { InvalidAmountError, parseAmountText } from '../money/parseAmountText';
import { normalizeVendorName } from '../vendors/normalizeVendorName';
import { runChecksAndComplete, type ProcessResult } from './runChecks';
import type { ExtractionFields, PipelineStore } from './store';

export const USD_ONLY_MESSAGE = 'Only USD bills are supported in this version.';
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong while processing this bill. Please review it manually.';

const FIELD_LABELS: Record<string, string> = {
  vendor_name: 'vendor',
  amount_text: 'amount',
  currency_code: 'currency',
  bill_date: 'date',
};

export type ProcessDeps = {
  store: PipelineStore;
  extract?: (buffer: Buffer, mimeType: string) => Promise<Extraction>;
  policyLimit: number | null;
};

function toFields(ex: Extraction): ExtractionFields {
  return {
    vendor_name: ex.vendor_name,
    amount_text: ex.amount_text,
    currency_code: ex.currency_code,
    bill_date: ex.bill_date,
    invoice_number: ex.invoice_number ?? null,
    payee_email: ex.payee_email ?? null,
    category: ex.category,
    confidence: ex.confidence,
  };
}

/**
 * Full pipeline for one bill: download -> Gemini -> validate -> vendor match ->
 * checks -> ready/flagged. Every outcome other than ready/flagged lands the bill
 * in needs_review with a plain-English message. Idempotent: a bill that is not
 * 'uploaded' is returned as-is (an 'extracted' bill resumes at the checks step).
 */
export async function processBill(billId: string, deps: ProcessDeps): Promise<ProcessResult> {
  const started = Date.now();
  const timing = { downloadMs: 0, geminiMs: 0 };
  let status = 'error';
  try {
    const result = await processBillSteps(billId, deps, timing);
    status = result.status;
    return result;
  } finally {
    const total = Date.now() - started;
    console.info(
      `[processBill] ${billId} -> ${status} in ${total} ms (download ${timing.downloadMs} ms, gemini ${timing.geminiMs} ms, database ${total - timing.downloadMs - timing.geminiMs} ms)`,
    );
  }
}

async function processBillSteps(
  billId: string,
  deps: ProcessDeps,
  timing: { downloadMs: number; geminiMs: number },
): Promise<ProcessResult> {
  const { store, policyLimit } = deps;
  const extract = deps.extract ?? realExtractBill;

  const bill = await store.getBill(billId);
  if (bill.status === 'extracted') {
    return runChecksAndComplete(billId, store, policyLimit); // resume after an interrupted run
  }
  if (bill.status !== 'uploaded') {
    return { billId, status: bill.status, flags: bill.flags, skipped: true };
  }

  const needsReview = async (
    fields: ExtractionFields,
    vendorId: string | null,
    lowConfidenceFields: string[],
    message: string,
  ): Promise<ProcessResult> => {
    await store.saveExtraction({ billId, fields, vendorId, status: 'needs_review', lowConfidenceFields, message });
    return { billId, status: 'needs_review', flags: [], error: message, lowConfidenceFields };
  };

  try {
    let t = Date.now();
    const file = await store.downloadBillFile(bill.storage_path);
    timing.downloadMs = Date.now() - t;

    let ex: Extraction;
    t = Date.now();
    try {
      ex = await extract(file.buffer, file.mimeType);
      timing.geminiMs = Date.now() - t;
    } catch (err) {
      timing.geminiMs = Date.now() - t;
      if (err instanceof GeminiTimeoutError || err instanceof GeminiServiceError || err instanceof ZodValidationError) {
        return await needsReview({}, null, [], err.message);
      }
      throw err;
    }

    const fields = toFields(ex);
    // For review cases, pre-select an existing vendor if the name matches, but never create one.
    const knownVendor = await store.findVendorByNormalizedName(normalizeVendorName(ex.vendor_name));
    const knownVendorId = knownVendor?.id ?? null;

    if (ex.currency_code !== 'USD') {
      return await needsReview(fields, knownVendorId, [], USD_ONLY_MESSAGE);
    }

    const low = getLowConfidenceFields(ex);
    if (low.length) {
      const what = low.map((f) => FIELD_LABELS[f] ?? f).join(', ');
      return await needsReview(fields, knownVendorId, low, `The AI was not sure about: ${what}. Please check these fields.`);
    }

    let cents: number;
    try {
      cents = parseAmountText(ex.amount_text, ex.currency_code);
    } catch (err) {
      if (!(err instanceof InvalidAmountError)) throw err;
      return await needsReview(fields, knownVendorId, ['amount_text'], `Could not read the amount "${ex.amount_text}". Please enter it.`);
    }

    if (!normalizeVendorName(ex.vendor_name)) {
      return await needsReview(fields, null, ['vendor_name'], 'Could not read the vendor name. Please enter it.');
    }

    const { vendorId } = await store.matchOrCreateVendor(ex.vendor_name);
    const vendor = await store.getVendor(vendorId);
    if (ex.payee_email && !vendor?.paypal_email) {
      await store.setVendorEmailIfMissing(vendorId, ex.payee_email);
    }

    await store.saveExtraction({
      billId,
      fields: { ...fields, amount_minor_units: cents, payee_email: ex.payee_email ?? vendor?.paypal_email ?? null },
      vendorId,
      status: 'extracted',
      lowConfidenceFields: [],
      message: null,
    });

    return await runChecksAndComplete(billId, store, policyLimit);
  } catch (err) {
    // Requirement 9.6: one bill's failure must not block the others. Park it in needs_review if we still can.
    console.error(`[processBill] ${billId}:`, err instanceof Error ? err.message : err);
    const current = await store.getBill(billId).catch(() => null);
    if (current?.status === 'uploaded') {
      try {
        return await needsReview({}, null, [], INTERNAL_ERROR_MESSAGE);
      } catch {
        /* fall through and report the original error */
      }
    } else if (current) {
      return { billId, status: current.status, flags: current.flags, skipped: true, error: current.review_message ?? undefined };
    }
    throw err;
  }
}
