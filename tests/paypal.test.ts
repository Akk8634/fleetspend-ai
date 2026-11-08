import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { centsToPayPalValue } from '../lib/paypal/amount';
import { toItemOutcome } from '../lib/paypal/status';
import { buildPayoutRequest, type PayoutItemInput } from '../lib/paypal/buildPayoutRequest';
import { createPayPalClient, PayPalApiError, PayPalNetworkError } from '../lib/paypal/client';
import { getPayPalConfig, SANDBOX_API_BASE } from '../lib/paypal/config';
import { parseAmountText } from '../lib/money/parseAmountText';

// ------------------------------------------------------------------ properties

describe('Feature: payment-workflow, Property 7: PayPal amount conversion is exact', () => {
  it('produces a two-decimal string that parses back to the same cents', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999_999 }), (cents) => {
        const value = centsToPayPalValue(cents);
        expect(value).toMatch(/^\d+\.\d{2}$/);
        expect(parseAmountText(value, 'USD')).toBe(cents);
      }),
      { numRuns: 500 },
    );
  });
  it.each([[1, '0.01'], [100, '1.00'], [12550, '125.50'], [999_999_999, '9999999.99']])('%d -> %s', (c, v) => {
    expect(centsToPayPalValue(c)).toBe(v);
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects %d', (c) => {
    expect(() => centsToPayPalValue(c)).toThrow(RangeError);
  });
});

describe('Feature: payment-workflow, Property 8: Status mapping is total and correct', () => {
  const table: [string, string][] = [
    ['SUCCESS', 'success'],
    ['PENDING', 'pending'], ['ONHOLD', 'pending'], ['UNCLAIMED', 'pending'], ['NEW', 'pending'],
    ['FAILED', 'failed'], ['RETURNED', 'failed'], ['BLOCKED', 'failed'], ['REFUNDED', 'failed'],
    ['REVERSED', 'failed'], ['DENIED', 'failed'], ['CANCELED', 'failed'],
  ];
  it.each(table)('%s -> %s (any case)', (status, outcome) => {
    expect(toItemOutcome(status)).toBe(outcome);
    expect(toItemOutcome(status.toLowerCase())).toBe(outcome);
  });
  it('maps every possible string to exactly one outcome', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (s) => {
        expect(['pending', 'success', 'failed']).toContain(toItemOutcome(s));
      }),
      { numRuns: 500 },
    );
  });
});

describe('Feature: payment-workflow, Property 9: Payout request preserves money and identity', () => {
  const itemArb = fc.record({
    id: fc.uuid(),
    receiver_email: fc.emailAddress(),
    amount_minor_units: fc.integer({ min: 1, max: 999_999_999 }),
    currency_code: fc.constant('USD' as const),
    note: fc.string({ maxLength: 80 }),
  });

  it('one PayPal item per payout item, unique ids, and the total is preserved', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uniqueArray(itemArb, { minLength: 1, maxLength: 50, selector: (i) => i.id }), (batchId, items) => {
        const req = buildPayoutRequest(batchId, items as PayoutItemInput[]);
        expect(req.sender_batch_header.sender_batch_id).toBe(batchId);
        expect(req.items).toHaveLength(items.length);
        expect(new Set(req.items.map((i) => i.sender_item_id)).size).toBe(items.length);
        expect(req.items.map((i) => i.sender_item_id)).toEqual(items.map((i) => i.id));
        const sent = req.items.reduce((s, i) => s + parseAmountText(i.amount.value, 'USD'), 0);
        expect(sent).toBe(items.reduce((s, i) => s + i.amount_minor_units, 0));
        expect(req.items.every((i) => i.recipient_type === 'EMAIL' && i.amount.currency === 'USD')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('refuses an empty batch', () => {
    expect(() => buildPayoutRequest('b', [])).toThrow();
  });
});

// ------------------------------------------------------------------ config

describe('getPayPalConfig', () => {
  it('returns null when credentials are missing', () => {
    expect(getPayPalConfig({})).toBeNull();
    expect(getPayPalConfig({ PAYPAL_CLIENT_ID: 'id' })).toBeNull();
  });
  it('defaults to the sandbox API', () => {
    expect(getPayPalConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' })?.apiBase).toBe(SANDBOX_API_BASE);
  });
  it('refuses non-sandbox hosts', () => {
    expect(() => getPayPalConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(/sandbox/);
  });
});

// ------------------------------------------------------------------ client

const config = { clientId: 'client-id-xyz', clientSecret: 'super-secret-value', apiBase: SANDBOX_API_BASE };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = () => json(200, { access_token: 'tok-123', token_type: 'Bearer', expires_in: 32400 });

describe('createPayPalClient', () => {
  it('caches the token until 60 s before expiry', async () => {
    let t = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/oauth2/token') ? tokenResponse() : json(200, { batch_header: { payout_batch_id: 'P1', batch_status: 'SUCCESS' }, items: [] }));
    const client = createPayPalClient({ config, fetch: fetchMock as unknown as typeof fetch, now: () => t });

    await client.getPayout('P1');
    await client.getPayout('P1');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/oauth2/token'))).toHaveLength(1);

    t = 32400 * 1000 - 59_000; // inside the 60 s refresh margin
    await client.getPayout('P1');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/oauth2/token'))).toHaveLength(2);
  });

  it('sends Basic auth for the token and the PayPal-Request-Id header on create', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      return String(url).endsWith('/v1/oauth2/token')
        ? tokenResponse()
        : json(201, { batch_header: { payout_batch_id: 'PPB-9', batch_status: 'PENDING' } });
    });
    const client = createPayPalClient({ config, fetch: fetchMock as unknown as typeof fetch });
    const res = await client.createPayout(buildPayoutRequest('batch-1', [
      { id: 'item-1', receiver_email: 'a@b.co', amount_minor_units: 21000, currency_code: 'USD', note: 'n' },
    ]), 'batch-1');

    expect(res.batch_header.payout_batch_id).toBe('PPB-9');
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toBe(`${SANDBOX_API_BASE}/v1/oauth2/token`);
    expect((tokenInit?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('client-id-xyz:super-secret-value').toString('base64')}`);
    const [createUrl, createInit] = fetchMock.mock.calls[1];
    expect(String(createUrl)).toBe(`${SANDBOX_API_BASE}/v1/payments/payouts`);
    const headers = createInit?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('batch-1');
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(String(createInit?.body)).items[0].amount).toEqual({ value: '210.00', currency: 'USD' });
  });

  it('turns PayPal error bodies into PayPalApiError without leaking secrets', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/oauth2/token')
        ? tokenResponse()
        : json(422, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.', debug_id: 'dbg1' }));
    const client = createPayPalClient({ config, fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getPayout('P1').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 422, errorName: 'INSUFFICIENT_FUNDS', debugId: 'dbg1', isClientError: true });
    expect(`${err.message} ${err.stack}`).not.toMatch(/super-secret-value|tok-123/);
  });

  it('reports bad credentials as a client error', async () => {
    const fetchMock = vi.fn(async () => json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }));
    const client = createPayPalClient({ config, fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getAccessToken().catch((e) => e);
    expect(err).toMatchObject({ status: 401, errorName: 'invalid_client', isClientError: true });
    expect(err.message).not.toContain('super-secret-value');
  });

  it('treats 5xx and 429 as retryable (not client errors)', () => {
    expect(new PayPalApiError(503, 'X', 'm').isClientError).toBe(false);
    expect(new PayPalApiError(429, 'X', 'm').isClientError).toBe(false);
  });

  it('turns network failures and timeouts into PayPalNetworkError', async () => {
    const down = createPayPalClient({ config, fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(down.getAccessToken()).rejects.toBeInstanceOf(PayPalNetworkError);

    const slow = createPayPalClient({
      config,
      timeoutMs: 20,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))))) as unknown as typeof fetch,
    });
    const err = await slow.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(PayPalNetworkError);
    expect(err.message).toContain('did not answer');
  });
});
