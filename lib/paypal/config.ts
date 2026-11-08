export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';

export type PayPalConfig = { clientId: string; clientSecret: string; apiBase: string };

/**
 * PayPal settings from the environment, or null when not configured.
 * Sandbox only: any API base whose host does not contain "sandbox" is refused.
 */
export function getPayPalConfig(env: Record<string, string | undefined> = process.env): PayPalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const apiBase = (env.PAYPAL_API_BASE?.trim() || SANDBOX_API_BASE).replace(/\/+$/, '');
  let host: string;
  try {
    host = new URL(apiBase).host;
  } catch {
    throw new Error('PAYPAL_API_BASE is not a valid URL');
  }
  if (!host.includes('sandbox')) {
    throw new Error('PAYPAL_API_BASE must be a PayPal sandbox host in this version');
  }
  return { clientId, clientSecret, apiBase };
}
