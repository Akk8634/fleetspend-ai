/**
 * Per-bill policy limit in minor units, from POLICY_LIMIT_MINOR_UNITS.
 * Returns null (check disabled) and logs a config error when the value is
 * missing, zero, negative or not an integer.
 */
export function getPolicyLimitMinorUnits(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.POLICY_LIMIT_MINOR_UNITS?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;

  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error('[config] POLICY_LIMIT_MINOR_UNITS is invalid or missing — policy-limit check disabled');
    return null;
  }
  return value;
}
