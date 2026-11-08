# Tech stack and conventions

- Next.js (App Router) + TypeScript (strict mode). Deployed on Vercel.
- Tailwind CSS for styling.
- Supabase: Postgres for data, Storage for bill files. Schema changes only via SQL migrations in supabase/migrations/.
- AI: Google Gemini API (vision for extraction, text for reasoning). Model name comes from env var GEMINI_MODEL, never hard-coded.
- AI output must be requested as structured JSON and validated with zod before use. Invalid output = show "needs manual review", never guess.
- Payments: PayPal Payouts REST API, sandbox only (https://api-m.sandbox.paypal.com). OAuth2 client-credentials token, cached until expiry.
- Approval table: AG Grid Community edition.
- Tests: Vitest for unit tests, fast-check for property-based tests on the checks and money logic.

## Installed versions (verified 2026-11-08)
- Next.js 16, React 19, @supabase/supabase-js 2, @google/genai 1, Vitest 3, fast-check 4.
- zod 4 (not 3): zod 3 has a known high-severity advisory. Use zod 4 APIs (e.g. z.email() is preferred over z.string().email()).
- Gemini model for development: gemini-3.8-flash (set via GEMINI_MODEL). gemini-2.5-flash is no longer available to new API users.

## Rules
- Money is stored as integer minor units (cents) plus a currency code. Never floats.
- All secrets (PayPal client secret, Gemini key, Supabase service key) are server-side only, read from env vars. Never expose them to the browser or commit them.
- Provide a .env.example with every variable, no real values.
- Small, focused modules. No microservices.
- Every external call (Gemini, PayPal) has error handling and a clear user-facing message.