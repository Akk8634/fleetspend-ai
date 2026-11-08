import type { PayPalConfig } from './config';
import type { PayPalPayoutRequest } from './buildPayoutRequest';

export const PAYPAL_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** PayPal answered with an HTTP error. */
export class PayPalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorName: string,
    message: string,
    public readonly debugId?: string,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
  get isClientError() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

/** No usable answer from PayPal (timeout, network failure). The outcome is unknown. */
export class PayPalNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalNetworkError';
  }
}

export type PayPalCreatePayoutResponse = {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
};

export type PayPalPayoutItem = {
  payout_item_id?: string;
  transaction_id?: string;
  transaction_status?: string;
  payout_item?: { sender_item_id?: string };
  errors?: { name?: string; message?: string };
};

export type PayPalGetPayoutResponse = {
  batch_header: { payout_batch_id: string; batch_status: string };
  items?: PayPalPayoutItem[];
};

export interface PayPalClient {
  createPayout(request: PayPalPayoutRequest, requestId: string): Promise<PayPalCreatePayoutResponse>;
  getPayout(paypalBatchId: string): Promise<PayPalGetPayoutResponse>;
}

type Deps = { config: PayPalConfig; fetch?: typeof fetch; now?: () => number; timeoutMs?: number };

/** Server-only PayPal REST client. Never logs or returns credentials or tokens. */
export function createPayPalClient({ config, fetch: fetchImpl = fetch, now = Date.now, timeoutMs = PAYPAL_TIMEOUT_MS }: Deps): PayPalClient & {
  getAccessToken(): Promise<string>;
} {
  let cached: { token: string; expiresAt: number } | null = null;

  async function call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${config.apiBase}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new PayPalNetworkError(timedOut ? `PayPal did not answer within ${timeoutMs / 1000} s` : 'Could not reach PayPal');
    }
  }

  async function toApiError(res: Response): Promise<PayPalApiError> {
    const body = (await res.json().catch(() => ({}))) as {
      name?: string; message?: string; debug_id?: string; error?: string; error_description?: string;
      details?: { issue?: string; description?: string }[];
    };
    const name = body.name ?? body.error ?? `HTTP_${res.status}`;
    const detail = body.details?.[0]?.description ?? body.details?.[0]?.issue;
    const message = [body.message ?? body.error_description ?? `PayPal returned HTTP ${res.status}`, detail]
      .filter(Boolean)
      .join(' — ');
    return new PayPalApiError(res.status, name, message, body.debug_id);
  }

  async function getAccessToken(): Promise<string> {
    if (cached && now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.token;
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const res = await call('/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw await toApiError(res);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }

  async function authed(path: string, init: RequestInit & { headers?: Record<string, string> }) {
    const token = await getAccessToken();
    const res = await call(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) cached = null; // force a fresh token next time
    if (!res.ok) throw await toApiError(res);
    return res.json();
  }

  return {
    getAccessToken,
    createPayout: (request, requestId) =>
      authed('/v1/payments/payouts', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': requestId },
        body: JSON.stringify(request),
      }) as Promise<PayPalCreatePayoutResponse>,
    getPayout: (paypalBatchId) =>
      authed(`/v1/payments/payouts/${encodeURIComponent(paypalBatchId)}?page_size=1000`, { method: 'GET' }) as Promise<PayPalGetPayoutResponse>,
  };
}
