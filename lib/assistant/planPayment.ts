import { GoogleGenAI } from '@google/genai';
import { criteriaResponseJsonSchema, planCriteriaSchema } from './criteriaSchema';
import { buildPlan, describeCriteria, PLAN_CAP_CENTS, type PaymentPlan, type PlanBill } from './planEngine';
import { buildCriteriaPrompt } from './prompt';

export const ASSISTANT_TIMEOUT_MS = 20_000;
export const FRIENDLY_FAILURE =
  "The assistant could not understand that. Try rephrasing, e.g. 'Pay all clean fuel bills from this week'.";

export class AssistantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantInputError';
  }
}

export class AssistantUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(FRIENDLY_FAILURE);
    this.name = 'AssistantUnavailableError';
  }
}

export type AssistantResult =
  | { kind: 'plan'; plan: PaymentPlan; chips: string[]; instruction: string }
  | { kind: 'clarify'; question: string; instruction: string };

export type PlanDeps = {
  listPayableBills: () => Promise<PlanBill[]>;
  listVendorNames: () => Promise<string[]>;
  /** Returns the model's raw JSON text for a prompt. Injectable for tests. */
  generateCriteria?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
  today?: string;
  planCapCents?: number;
  timeoutMs?: number;
};

const geminiGenerate = async (prompt: string, signal: AbortSignal) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) throw new Error('GEMINI_API_KEY / GEMINI_MODEL not set');
  const res = await new GoogleGenAI({ apiKey }).models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: criteriaResponseJsonSchema,
      temperature: 0,
      abortSignal: signal,
    },
  });
  return res.text;
};

/**
 * Agent step: instruction -> criteria (AI) -> plan (deterministic code).
 * Nothing is paid here; the Owner approves the plan in the approval dialog.
 */
export async function planPayment(rawInstruction: unknown, deps: PlanDeps): Promise<AssistantResult> {
  const instruction = typeof rawInstruction === 'string' ? rawInstruction.trim().replace(/\s+/g, ' ') : '';
  if (instruction.length < 3 || instruction.length > 300) {
    throw new AssistantInputError('Type an instruction between 3 and 300 characters.');
  }

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const [bills, vendorNames] = await Promise.all([deps.listPayableBills(), deps.listVendorNames()]);
  const prompt = buildCriteriaPrompt({ instruction, today, vendorNames });

  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? ASSISTANT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string | undefined;
  try {
    text = await Promise.race([
      (deps.generateCriteria ?? geminiGenerate)(prompt, controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error(`timed out after ${timeoutMs} ms`))),
      ),
    ]);
  } catch (err) {
    throw new AssistantUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(text ?? '');
  } catch {
    throw new AssistantUnavailableError('response was not JSON');
  }
  const parsed = planCriteriaSchema.safeParse(json);
  if (!parsed.success) {
    throw new AssistantUnavailableError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const criteria = parsed.data;
  if (criteria.intent === 'clarify') {
    return { kind: 'clarify', question: criteria.clarification_question ?? 'Which bills would you like to pay?', instruction };
  }
  const plan = buildPlan(bills, criteria, { planCapCents: deps.planCapCents ?? PLAN_CAP_CENTS });
  return { kind: 'plan', plan, chips: describeCriteria(criteria), instruction };
}
