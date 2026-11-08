import { z } from 'zod';
import { CORE_FIELDS } from '../db/types';

export const LOW_CONFIDENCE_THRESHOLD = 0.8;
export const CATEGORIES = ['fuel', 'repair', 'parts', 'driver_trip', 'other'] as const;

const score = z.number().min(0).max(1);

// Empty strings from the model are treated as "not present".
const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().nullable().optional(),
);

const isCalendarDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Validates Gemini's JSON before any field is trusted (Requirement 2.3). */
export const extractionSchema = z.object({
  vendor_name: z.string().trim().min(1).max(255),
  payee_email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.email().nullable().optional(),
  ),
  amount_text: z.string().trim().min(1),
  currency_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code'),
  bill_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .refine(isCalendarDate, 'is not a real calendar date'),
  invoice_number: optionalText,
  category: z.enum(CATEGORIES).catch('other'),
  confidence: z.object({
    vendor_name: score,
    payee_email: score.optional(),
    amount_text: score,
    currency_code: score,
    bill_date: score,
    invoice_number: score.optional(),
    category: score.optional(),
  }),
});

export type Extraction = z.infer<typeof extractionSchema>;

/** Core fields whose confidence is below the threshold (optional fields never count). */
export function getLowConfidenceFields(extraction: Extraction): string[] {
  return CORE_FIELDS.filter((field) => extraction.confidence[field] < LOW_CONFIDENCE_THRESHOLD);
}

/** JSON Schema given to Gemini's JSON mode; mirrors extractionSchema. */
export const geminiResponseJsonSchema = {
  type: 'object',
  properties: {
    vendor_name: { type: 'string' },
    payee_email: { type: ['string', 'null'] },
    amount_text: { type: 'string' },
    currency_code: { type: 'string' },
    bill_date: { type: 'string', description: 'YYYY-MM-DD' },
    invoice_number: { type: ['string', 'null'] },
    category: { type: 'string', enum: [...CATEGORIES] },
    confidence: {
      type: 'object',
      properties: {
        vendor_name: { type: 'number' },
        payee_email: { type: 'number' },
        amount_text: { type: 'number' },
        currency_code: { type: 'number' },
        bill_date: { type: 'number' },
        invoice_number: { type: 'number' },
        category: { type: 'number' },
      },
      required: ['vendor_name', 'amount_text', 'currency_code', 'bill_date'],
    },
  },
  required: ['vendor_name', 'amount_text', 'currency_code', 'bill_date', 'category', 'confidence'],
} as const;

// ---------------------------------------------------------------- errors

export class GeminiTimeoutError extends Error {
  constructor(public readonly attempts: number) {
    super(`AI extraction timed out after ${attempts} attempts.`);
    this.name = 'GeminiTimeoutError';
  }
}

export class GeminiServiceError extends Error {
  constructor(public readonly attempts: number, public readonly detail: string) {
    super(`AI service error after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${detail}`);
    this.name = 'GeminiServiceError';
  }
}

export class ZodValidationError extends Error {
  constructor(public readonly issues: { field: string; message: string }[]) {
    super(`AI returned data we could not trust: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`);
    this.name = 'ZodValidationError';
  }
}
