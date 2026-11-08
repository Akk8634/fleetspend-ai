import { ApiError, GoogleGenAI } from '@google/genai';
import { EXTRACTION_PROMPT } from './prompt';
import {
  extractionSchema,
  geminiResponseJsonSchema,
  GeminiServiceError,
  GeminiTimeoutError,
  ZodValidationError,
  type Extraction,
} from './extractionSchema';

export const GEMINI_TIMEOUT_MS = 20_000;
export const GEMINI_RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 2; // first try + 1 retry

/** Calls the model once and returns its raw text. Injectable for tests. */
export type GenerateFn = (args: {
  model: string;
  fileBase64: string;
  mimeType: string;
  signal: AbortSignal;
}) => Promise<string | undefined>;

export type ExtractDeps = {
  generate?: GenerateFn;
  model?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let cachedClient: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiServiceError(0, 'GEMINI_API_KEY is not set');
  cachedClient ??= new GoogleGenAI({ apiKey });
  return cachedClient;
}

const geminiGenerate: GenerateFn = async ({ model, fileBase64, mimeType, signal }) => {
  const response = await client().models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: EXTRACTION_PROMPT }, { inlineData: { mimeType, data: fileBase64 } }],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: geminiResponseJsonSchema,
      temperature: 0,
      abortSignal: signal,
    },
  });
  return response.text;
};

type AttemptFailure = { kind: 'timeout' } | { kind: 'service'; detail: string; retryable: boolean };

function classify(err: unknown, signal: AbortSignal): AttemptFailure {
  if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return { kind: 'timeout' };
  if (err instanceof ApiError) {
    // 429 (rate limit) and 5xx are worth one retry; other 4xx will fail the same way again.
    const retryable = err.status === 429 || err.status >= 500;
    return { kind: 'service', detail: `HTTP ${err.status}`, retryable };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { kind: 'service', detail: detail.slice(0, 200), retryable: true }; // network errors
}

/**
 * Send a bill to Gemini and return validated fields.
 * 20 s timeout per attempt, one retry after 5 s on timeout/network/429/5xx.
 * Throws GeminiTimeoutError | GeminiServiceError | ZodValidationError.
 */
export async function extractBill(fileBuffer: Buffer, mimeType: string, deps: ExtractDeps = {}): Promise<Extraction> {
  const model = deps.model ?? process.env.GEMINI_MODEL;
  if (!model) throw new GeminiServiceError(0, 'GEMINI_MODEL is not set');

  const generate = deps.generate ?? geminiGenerate;
  const timeoutMs = deps.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? GEMINI_RETRY_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const fileBase64 = fileBuffer.toString('base64');

  let lastFailure: AttemptFailure = { kind: 'service', detail: 'no attempt made', retryable: false };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text: string | undefined;

    try {
      text = await Promise.race([
        generate({ model, fileBase64, mimeType, signal: controller.signal }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))),
        ),
      ]);
    } catch (err) {
      lastFailure = classify(err, controller.signal);
      clearTimeout(timer);
      const canRetry = lastFailure.kind === 'timeout' || lastFailure.retryable;
      if (attempt < MAX_ATTEMPTS && canRetry) {
        console.warn(
          `[extractBill] attempt ${attempt} failed (${lastFailure.kind === 'timeout' ? 'timeout' : lastFailure.detail}); retrying in ${retryDelayMs} ms`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      throw lastFailure.kind === 'timeout'
        ? new GeminiTimeoutError(attempt)
        : new GeminiServiceError(attempt, lastFailure.detail);
    }
    clearTimeout(timer);

    // A response arrived: parse and validate it. Bad data is not retried.
    let json: unknown;
    try {
      json = JSON.parse(text ?? '');
    } catch {
      throw new ZodValidationError([{ field: 'response', message: 'was not valid JSON' }]);
    }
    const parsed = extractionSchema.safeParse(json);
    if (!parsed.success) {
      // One entry per field, even if a field failed several rules.
      const byField = new Map<string, string[]>();
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.') || 'response';
        byField.set(field, [...(byField.get(field) ?? []), issue.message]);
      }
      throw new ZodValidationError(
        [...byField].map(([field, messages]) => ({ field, message: messages.join(', ') })),
      );
    }
    return parsed.data;
  }

  // Unreachable, but keeps TypeScript satisfied.
  throw lastFailure.kind === 'timeout'
    ? new GeminiTimeoutError(MAX_ATTEMPTS)
    : new GeminiServiceError(MAX_ATTEMPTS, lastFailure.detail);
}
