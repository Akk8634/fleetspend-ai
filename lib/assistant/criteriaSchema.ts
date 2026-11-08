import { z } from 'zod';
import { CATEGORIES } from '../ai/extractionSchema';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a real date');

const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullish());

/**
 * What the AI may return. Unknown keys (e.g. an attempt to return bill ids) are stripped:
 * the AI chooses criteria only, never bills or amounts to pay.
 */
export const planCriteriaSchema = z
  .object({
    intent: z.enum(['plan', 'clarify']),
    clarification_question: optionalText(z.string().max(300)),
    vendor_names: z.array(z.string().trim().min(1).max(100)).max(10).nullish().transform((v) => v ?? []),
    categories: z.array(z.enum(CATEGORIES)).max(5).nullish().transform((v) => v ?? []),
    date_from: optionalText(isoDate),
    date_to: optionalText(isoDate),
    max_amount_per_bill: optionalText(z.string().max(20)),
    max_total: optionalText(z.string().max(20)),
    include_flagged: z.boolean().nullish().transform((v) => v ?? false),
    include_failed: z.boolean().nullish().transform((v) => v ?? false),
    summary: z.string().trim().min(1).max(500),
  })
  .strip();

export type PlanCriteria = z.infer<typeof planCriteriaSchema>;

/** JSON Schema for Gemini's JSON mode; mirrors planCriteriaSchema. */
export const criteriaResponseJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['plan', 'clarify'] },
    clarification_question: { type: ['string', 'null'] },
    vendor_names: { type: 'array', items: { type: 'string' } },
    categories: { type: 'array', items: { type: 'string', enum: [...CATEGORIES] } },
    date_from: { type: ['string', 'null'], description: 'YYYY-MM-DD, inclusive' },
    date_to: { type: ['string', 'null'], description: 'YYYY-MM-DD, inclusive' },
    max_amount_per_bill: { type: ['string', 'null'], description: 'USD decimal, e.g. "500.00"' },
    max_total: { type: ['string', 'null'], description: 'USD decimal, e.g. "1000.00"' },
    include_flagged: { type: 'boolean' },
    include_failed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['intent', 'include_flagged', 'include_failed', 'summary'],
} as const;
