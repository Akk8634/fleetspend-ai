# Implementation Plan: Invoice Processing

## Overview

Implement the full invoice-processing pipeline for FleetSpend AI: database schema + RPC functions, money utilities, vendor normalization, the four check-engine pure functions, Gemini extraction, API route handlers, and the React UI components. Each task builds directly on the previous, with property-based and unit tests placed immediately after the code they cover.

## Tasks

- [x] 0. Project initialization
  - Initialize Next.js app with App Router, TypeScript strict mode, and Tailwind CSS using `npx create-next-app@latest` with the appropriate flags
  - Install runtime dependencies: `@supabase/supabase-js`, `@google/genai`, `zod`
  - Install dev dependencies: `vitest`, `@vitest/coverage-v8`, `fast-check`, `@types/node`
  - Create `vitest.config.ts` configured for Next.js (use `defineConfig` from vitest, set `environment: 'node'`, include `tests/**/*.test.ts`)
  - Add `"test": "vitest --run"` script to `package.json`
  - Add `LICENSE` file with MIT license text (year 2026, copyright holder "FleetSpend AI")
  - Add `.gitignore` that includes `.env*.local`, `node_modules/`, `.next/`, `dist/` — and explicitly NEVER ignores `.kiro` (do not add `.kiro` to `.gitignore` under any circumstances)
  - Create `README.md` stub with: project name "FleetSpend AI", one-sentence description, "Getting Started" section with `npm install`, `supabase db push`, `npm run dev`
  - _Requirements: (scaffolding — no direct requirement reference)_

- [ ] 2. Project scaffolding, environment config, and database migrations
  - Create `.env.example` with all required environment variables (server-only, no NEXT_PUBLIC_ variables):
    `SUPABASE_URL=`, `SUPABASE_SERVICE_ROLE_KEY=`, `GEMINI_API_KEY=`, `GEMINI_MODEL=`, `POLICY_LIMIT_MINOR_UNITS=100000`, `DEMO_MODE=true`
  - Create `supabase/migrations/001_create_vendors.sql` — `vendors` table with `id`, `name`, `normalized_name UNIQUE`, `paypal_email`, `category`, `created_at`; index on `normalized_name`
  - Create `supabase/migrations/002_create_bills.sql` — `bills` table with all columns per design (UUID PK, `status` CHECK constraint, `amount_minor_units INTEGER`, `confidence JSONB`, `low_confidence_fields TEXT[]`, `updated_at` trigger); indexes on `vendor_id`, `status`, `(vendor_id, status)`; add `is_seed BOOLEAN NOT NULL DEFAULT false` column to the `bills` table
  - Create `supabase/migrations/003_create_flags.sql` — `flags` table with `bill_id` FK CASCADE; index on `bill_id`
  - Create `supabase/migrations/004_create_audit_log.sql` — `audit_log` table; index on `bill_id`; append-only trigger (`audit_log_immutable`) that blocks UPDATE and DELETE with an exception
  - Create `supabase/migrations/005_create_rpc_functions.sql` — all seven RPC functions: `transition_bill_status`, `create_bill`, `save_extraction`, `save_field_corrections`, `complete_checks`, `reset_demo` (SECURITY DEFINER, SET search_path = public), `seed_demo_data`; enable RLS on all four tables; REVOKE EXECUTE from `public`, `anon`, `authenticated` and GRANT EXECUTE to `service_role` for every function
    `seed_demo_data()` must insert exactly these 5 vendors and 15 paid bills:
    Vendors: Apex Fuel Co (fuel, apex-fuel@example.com), Metro Auto Repair (repair, metro-repair@example.com), ProParts Supply (parts, proparts@example.com), Driver Direct Ltd (driver_trip, driver-direct@example.com), City Lube Station (other, city-lube@example.com).
    Paid bills (all USD, status='paid'): APX-001 $220.00 2025-11-10, APX-002 $180.00 2026-02-05, APX-003 $200.00 2026-06-15; MAR-001 $850.00 2025-11-20, MAR-002 $920.00 2026-03-30, MAR-003 $780.00 2026-08-01; PPS-001 $340.00 2025-12-12, PPS-002 $310.00 2026-04-18, PPS-003 $360.00 2026-09-22; DDL-001 $150.00 2025-11-05, DDL-002 $175.00 2026-01-10, DDL-003 $160.00 2026-07-08; CLS-001 $95.00 2025-12-25, CLS-002 $105.00 2026-05-30, CLS-003 $88.00 2026-10-01.
    Each of the 15 paid bills must be inserted with `is_seed = true`, `storage_path = 'seed/<invoice_number>'` (e.g. `'seed/APX-001'`), and `original_filename = '<invoice_number>.pdf'` (e.g. `'APX-001.pdf'`); no real files exist at those paths.
  - Create `supabase/migrations/006_create_storage_bucket.sql` — create the private `bills` Storage bucket: `INSERT INTO storage.buckets (id, name, public) VALUES ('bills', 'bills', false) ON CONFLICT DO NOTHING;`
  - Create `supabase/seed.sql` containing exactly: `SELECT seed_demo_data();`
  - _Requirements: 1.4, 1.5, 1.6, 11.6, 11.7, 12.1, 12.2, 13.2_

- [ ] 3. Money utilities
  - [ ] 3.1 Implement `lib/money/parseAmountText.ts`
    - Export `class InvalidAmountError extends Error`
    - Implement `parseAmountText(amountText: string, currencyCode: string): number` exactly per the design algorithm: strip commas, regex match `^(\d+)(?:\.(\d{1,2}))?$`, multiply parts separately, enforce range 1–999,999,999
    - _Requirements: 2.6, 4.5, 10.6_

  - [ ] 3.2 Implement `lib/money/formatCurrency.ts`
    - Export `formatCurrency(minorUnits: number): string` per the design: integer floor division for dollars, modulo for cents, `toLocaleString('en-US')` for thousands separator
    - _Requirements: 6.6, 8.2_

  - [ ] 3.3 Write unit tests for money utilities (`tests/money.test.ts`)
    - `parseAmountText`: valid integers, valid decimals, comma-separated thousands, single decimal place (e.g. `"5.5"`), boundary values (1 minor unit = `"0.01"`, max = `"9999999.99"`), invalid inputs (letters, empty string, three decimal places, zero, value out of range)
    - `formatCurrency`: known values (e.g. 22000 → `"$220.00"`), zero cents (e.g. 100 → `"$1.00"`), cents < 10 (padded), large amounts with thousands separator
    - _Requirements: 10.6_

  - [ ] 3.4 Write property test for amount round-trip (`tests/money.test.ts`)
    - **Property 6: Amount conversion round-trip**
    - Arbitrary: `fc.tuple(fc.integer({ min: 0, max: 9_999_999 }), fc.integer({ min: 0, max: 99 }))` → construct `amount_text = \`${dollars}.${String(cents).padStart(2, '0')}\``
    - Assert: `parseAmountText(amountText, 'USD') === dollars * 100 + cents`
    - **Validates: Requirements 10.6, 2.6**

- [ ] 4. Vendor utilities
  - [ ] 4.1 Implement `lib/vendors/normalizeVendorName.ts`
    - Export `normalizeVendorName(name: string): string` with exactly this pipeline (order matters):
      1. Lowercase → trim
      2. Remove all punctuation: `replace(/[^\w\s]/g, '')`
      3. Expand `stn` → `station`: `replace(/\bstn\b/g, 'station')`
      4. Strip legal suffixes: `replace(/\b(co|company|inc|ltd|llc)\b/g, '')`
      5. Collapse multiple spaces → trim
    - _Requirements: 2.5_

  - [ ] 4.2 Write unit tests for `normalizeVendorName` (`tests/vendors.test.ts`)
    - `"City Lube Stn."` → `"city lube station"`
    - `"City Lube Station"` → `"city lube station"`
    - `"Apex Fuel Company"` → `"apex fuel"`
    - `"Apex Fuel Co"` → `"apex fuel"`
    - `"Metro Auto Repair Inc."` → `"metro auto repair"`
    - `"  Highway  Diesel  Inc  "` → `"highway diesel"` (whitespace collapsing)
    - _Requirements: 2.5_

  - [ ] 4.3 Implement `lib/vendors/matchOrCreateVendor.ts`
    - Import `normalizeVendorName`; import Supabase client type
    - `matchOrCreateVendor(extractedName: string, supabase: SupabaseClient): Promise<{ vendorId: string }>`
    - Query `vendors` by `normalized_name`; if found return its id; if not found INSERT with `name = extractedName`, `normalized_name`, `category = null`, `paypal_email = null`; return new id
    - _Requirements: 2.5_

- [ ] 5. Check engine — pure functions
  - [ ] 5.1 Implement `lib/checks/checkDuplicate.ts`
    - Export `Flag` type: `{ check_name: 'duplicate' | 'overcharge' | 'new_payee' | 'policy_limit'; reason: string }`
    - Export `BillForCheck` and `ExistingBill` types per the design
    - Implement `checkDuplicate(bill: BillForCheck, existingBills: ExistingBill[]): Flag | null`
    - Exclude self (`existing.id === bill.id`); match set A (vendor + invoice_number, both non-null); match set B (vendor + amount + date); union; if empty return null; find earliest match by bill_date lexicographic sort; return flag with exact reason format from design
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ] 5.2 Implement `lib/checks/checkOvercharge.ts`
    - Import `formatCurrency`
    - Implement `checkOvercharge(bill: { amount_minor_units: number; vendor_name: string }, history: { count: number; sum: number }): Flag | null`
    - Return null if `history.count < 2`
    - Use `BigInt(bill.amount_minor_units) * BigInt(history.count) > 2n * BigInt(history.sum)` for threshold — no floats
    - Display average: `Math.round(history.sum / history.count)` — for display only, never in comparison
    - Return overcharge flag with reason from design
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ] 5.3 Implement `lib/checks/checkNewPayee.ts`
    - Implement `checkNewPayee(vendorId: string, vendorName: string, paidVendorIds: Set<string>): Flag | null`
    - Return `new_payee` flag with reason `"First-time payee: [vendorName] has no payment history."` when `vendorId` absent from set; else null
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 5.4 Implement `lib/checks/checkPolicyLimit.ts`
    - Import `formatCurrency`
    - Implement `checkPolicyLimit(amount: number, limit: number | null): Flag | null`
    - Return null when `limit === null`; return `policy_limit` flag when `amount > limit`; else null
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 5.5 Write unit tests for check engine (`tests/checks.test.ts`)
    - `checkDuplicate`: no-flag (empty list), no-flag (self-exclusion), flag via invoice_number match, flag via amount+date match, flag via both (one flag only, earliest match), no flag when invoice_number is null on both sides
    - `checkOvercharge`: no flag (count = 1), no flag (amount at exact threshold), flag (amount above threshold), BigInt boundary (large values)
    - `checkNewPayee`: flag (absent from set), no flag (present in set), empty set
    - `checkPolicyLimit`: null limit → no flag, amount = limit → no flag, amount > limit → flag, amount < limit → no flag
    - _Requirements: 5.5, 6.4, 7.4, 8.4_

  - [ ] 5.6 Write property tests for check engine (`tests/checks.test.ts`)
    - **Property 1: Duplicate check — no flag when no match exists**
      - Arbitrary: bill and list of existing bills where no entry matches set A or set B conditions; exclude self by construction
      - Assert: `checkDuplicate(bill, existingBills) === null`
      - **Validates: Requirements 5.1, 5.2, 5.5, 5.6**
    - **Property 2: Overcharge check — no flag when below threshold**
      - Arbitraries: `amount` (`fc.integer({min:1, max:999_999_999})`), `count` (`fc.integer({min:2, max:9_007})`), construct `sum` from `fc.array` of per-bill amounts with length=count (per-bill amounts capped at `fc.integer({ min: 1, max: 499_999_999 })` so the sum stays safely below Number.MAX_SAFE_INTEGER for count ≤ 9_007); scale `amount = Math.floor(Number(2n * BigInt(sum) / BigInt(count)))` clamped to [1, 999_999_999] to satisfy `amount * count ≤ 2 * sum`
      - Assert: `checkOvercharge({ amount_minor_units: amount, vendor_name: 'v' }, { count, sum: Number(sum) }) === null`
      - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
    - **Property 3: Overcharge check — flag when above threshold**
      - Same `fc.array` construction as Property 2, but per-bill amounts capped at `fc.integer({ min: 1, max: 499_999_999 })` so that `floor(2 * sum / count) + 1` never exceeds 999_999_999 (the max valid amount); count capped at 9_007
      - `amount = Math.min(999_999_999, Math.floor(Number(2n * BigInt(sum) / BigInt(count))) + 1)`
      - Assert: `checkOvercharge(...).check_name === 'overcharge'`
      - **Validates: Requirements 6.1, 6.2, 6.4, 6.5**
    - **Property 4: Policy-limit check — correct flag/no-flag based on comparison**
      - Arbitrary: `fc.tuple(fc.integer({min:1}), fc.integer({min:1}))`
      - Assert: `amount > limit ↔ checkPolicyLimit(amount, limit)?.check_name === 'policy_limit'`
      - **Validates: Requirements 8.2, 8.3, 8.4**
    - **Property 5: New-payee check — flag iff vendor has no paid history**
      - Arbitrary: `fc.tuple(fc.uuid(), fc.array(fc.uuid()))`
      - Assert: `!paidVendorIds.has(vendorId) ↔ checkNewPayee(vendorId, 'v', new Set(paidVendorIds)) !== null`
      - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [ ] 6. Checkpoint — verify pure-function layer
  - Ensure all tests in `tests/money.test.ts`, `tests/vendors.test.ts`, and `tests/checks.test.ts` pass. Ask the user if any questions arise.

- [ ] 7. Supabase client and database access layer
  - [ ] 7.1 Create `lib/db/client.ts`
    - Export `createServerClient()` that returns the Supabase client initialised with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from env vars (never the anon key for write operations)
    - _Requirements: 1.4, 1.5_

  - [ ] 7.2 Implement `lib/db/bills.ts`
    - `getBillById(id: string, supabase): Promise<Bill>`
    - `getBillsForDuplicateCheck(vendorId: string, supabase): Promise<ExistingBill[]>` — WHERE `vendor_id = $1 AND status NOT IN ('uploaded', 'needs_review')`
    - `getOverchargeHistory(vendorId: string, currencyCode: string, supabase): Promise<{ count: number; sum: number }>` — SELECT COUNT(*), SUM(amount_minor_units) WHERE `vendor_id=$1 AND currency_code=$2 AND status='paid'`
    - `getPaidVendorIds(supabase): Promise<Set<string>>` — SELECT DISTINCT vendor_id WHERE `status='paid'`
    - _Requirements: 5.1, 6.1, 7.1_

  - [ ] 7.3 Implement `lib/db/vendors.ts`
    - `getVendorByNormalizedName(normalizedName: string, supabase): Promise<Vendor | null>`
    - `createVendor(fields: NewVendor, supabase): Promise<Vendor>`
    - _Requirements: 2.5_

  - [ ] 7.4 Implement `lib/db/checks.ts`
    - `getPolicyLimitMinorUnits(): number | null` — reads `POLICY_LIMIT_MINOR_UNITS` from `process.env`; returns null (and logs config error server-side) when absent, zero, negative, or non-integer
    - _Requirements: 8.1_

- [ ] 8. AI extraction layer
  - [ ] 8.1 Create `lib/ai/prompt.ts`
    - Export the extraction prompt string exactly as specified in the design (fields, schema comment, confidence scoring instructions)
    - _Requirements: 2.2_

  - [ ] 8.2 Create `lib/ai/extractionSchema.ts`
    - Export `extractionSchema` zod object and `Extraction` type matching the design spec exactly
    - Export typed error classes: `GeminiTimeoutError`, `GeminiServiceError`, `ZodValidationError`
    - _Requirements: 2.3, 2.4_

  - [ ] 8.3 Implement `lib/ai/extractBill.ts`
    - `extractBill(fileBuffer: Buffer, mimeType: string): Promise<Extraction>`
    - Send `fileBuffer` as inline part to model `process.env.GEMINI_MODEL`; set `responseMimeType: "application/json"` with `responseSchema` mirroring the zod schema shape (Gemini JSON mode)
    - AbortController timeout: 20 seconds
    - On timeout or network error: wait 5 s, retry once; on second failure throw `GeminiTimeoutError` or `GeminiServiceError`
    - On success: `JSON.parse` response text, validate with `extractionSchema`; throw `ZodValidationError` on failure
    - _Requirements: 2.1, 2.8, 2.9_

- [ ] 9. Upload API route
  - [ ] 9.1 Create `app/api/bills/upload/route.ts`
    - Parse `multipart/form-data` via `request.formData()`
    - Per-file validation: MIME type in `['image/jpeg', 'image/png', 'application/pdf']`, size ≤ 10 MB; reject with filename + reason on failure without aborting other files
    - For each valid file: generate UUID, store to `bills/{uuid}/{original_filename}` in Supabase Storage (private bucket)
    - On Storage success: call `create_bill(storagePath, originalFilename)` RPC; on RPC failure: delete stored file, return error for that file
    - On Storage failure: return error for that file; no DB record created
    - Return `{ results: [{ filename, billId, status } | { filename, error }] }` once all files are processed
    - Enforce max 20 files / 100 MB combined
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

- [ ] 10. Process API route (extraction + checks pipeline)
  - [ ] 10.1 Create `app/api/bills/[id]/process/route.ts`
    - Add `export const maxDuration = 60` at the top of the file to extend the Vercel serverless function timeout to 60 seconds
    - Load bill by id; if `status !== 'uploaded'` return `{ billId, status, flags, skipped: true }` immediately (idempotency)
    - Download the bill file from Storage using `supabase.storage.from('bills').download(storagePath)` (service role client, no signed URL needed server-side)
    - Call `extractBill(buffer, mimeType)` with 20 s timeout + 1 retry
    - On `GeminiTimeoutError` or `GeminiServiceError`: call `save_extraction` RPC with empty fields `{}`, `new_status='needs_review'`, error message; return `{ billId, status: 'needs_review', error }`
    - On `ZodValidationError`: call `save_extraction` RPC with empty fields, `needs_review`, message listing failing fields; return error response
    - On success: validate `currency_code === 'USD'`; if not call `save_extraction` with extracted fields, `needs_review`, "Only USD bills are supported in this version."; return needs_review response
    - Identify low-confidence core fields (`vendor_name`, `amount_text`, `currency_code`, `bill_date` where confidence < 0.8); if any: call `save_extraction` with all fields, `needs_review`, `low_confidence_fields` array populated; return needs_review response
    - On valid extraction: call `matchOrCreateVendor`; call `parseAmountText`; call `save_extraction` RPC with all fields, `vendor_id`, `status='extracted'`
    - Fetch check data: `getBillsForDuplicateCheck`, `getOverchargeHistory`, `getPaidVendorIds`, `getPolicyLimitMinorUnits`
    - Run all four checks; collect flags; call `complete_checks` RPC with `billId` and flags array
    - Return `{ billId, status: 'ready' | 'flagged', flags }`
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 3.1, 3.2, 3.3, 4.1, 5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 8.1, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 11.1_

- [ ] 11. Correct API route (manual review submission)
  - [ ] 11.1 Create `app/api/bills/[id]/correct/route.ts`
    - Parse and validate request body: `vendor_name` (non-empty, ≤ 255), `currency_code` (valid ISO 4217 AND must be `USD`), `amount` (positive decimal ≤ 2 dp, convert to minor units via `parseAmountText`, range 1–999,999,999), `bill_date` (calendar-valid YYYY-MM-DD), optional `vendor_id` (UUID), `invoice_number`, `payee_email`
    - On validation failure: return 400 with field-level error details; no DB changes
    - If `vendor_name` provided and `vendor_id` is null/absent: call `matchOrCreateVendor`; else use provided `vendor_id`
    - Call `save_field_corrections` RPC with bill id, corrections JSONB, actor `"demo_owner"`
    - Fetch updated bill data; re-run all four checks; call `complete_checks` RPC
    - Return `{ billId, status, flags }`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 9.1, 9.2, 9.3, 9.4_

- [ ] 12. Demo reset API route
  - [ ] 12.1 Create `app/api/demo/reset/route.ts`
    - Check `process.env.DEMO_MODE === 'true'`; return 403 if false
    - Delete all objects in the `bills` Storage bucket using service role client
    - Call `reset_demo()` RPC
    - Return `{ success: true }` or `{ error: string }`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [ ]* 13. Checkpoint — verify API route layer
  - Ensure upload, process, correct, and demo reset handlers return correct HTTP status codes, response shapes, and call RPC with the expected arguments (use mocked Supabase and Gemini clients). Ask the user if any questions arise.

- [ ] 14. UI components
  - [ ] 14.1 Implement `components/BillStatusBadge.tsx`
    - Props: `status: 'uploaded' | 'extracted' | 'needs_review' | 'ready' | 'flagged' | 'paid'`
    - Render a badge with Tailwind color per status: uploaded→gray, extracted→blue, needs_review→amber, ready→green, flagged→red, paid→teal
    - _Requirements: 9.2, 9.3_

  - [ ] 14.2 Implement `components/BillReviewForm.tsx`
    - Props: bill record (pre-filled extracted fields), list of existing vendors
    - Fields: vendor selector (existing vendors + "New vendor" option), `vendor_name` text input, `currency_code`, `amount` (decimal string, show `formatCurrency` display alongside), `bill_date`, `invoice_number`, `payee_email`
    - Visually highlight (amber border + warning icon) fields whose `confidence < 0.8` (from `low_confidence_fields` array on bill)
    - On submit: POST to `PATCH /api/bills/[id]/correct`; display field-level validation errors returned by the API
    - All amounts displayed as formatted currency strings, never as minor units integers
    - _Requirements: 4.2, 4.3, 4.4, 4.8_

  - [ ] 14.3 Implement `components/ResetDemoButton.tsx`
    - Only rendered when `DEMO_MODE=true` (passed as prop from server component)
    - Show confirmation dialog before calling `POST /api/demo/reset`
    - On success: redirect to upload page
    - _Requirements: 13.1, 13.4, 13.5_

  - [ ] 14.4 Implement `components/UploadZone.tsx`
    - Drag-and-drop area + "Browse" button; accept `image/jpeg`, `image/png`, `application/pdf`
    - Client-side pre-validation: MIME type and 10 MB size before sending
    - Show per-file indeterminate spinner during upload
    - After all uploads: sequentially call `POST /api/bills/[id]/process` for each successful bill, waiting for each to finish before starting the next
    - Show inline result per file: `BillStatusBadge` + flag summary if flagged, or error message
    - _Requirements: 1.1, 1.2, 1.3, 1.9, 1.10, 9.6_

- [ ] 15. Pages
  - [ ] 15.1 Create `app/page.tsx` (server component)
    - Fetch all bills where `is_seed = false` (uploaded by the user, not seeded history) plus the vendor name for each
    - Render `UploadZone` at the top
    - Below: a list/table of bills showing `BillStatusBadge`, formatted amount via `formatCurrency`, vendor name, and flag reasons (if any)
    - For each bill with `status = 'needs_review'`, render a "Review" link to `/bills/[id]/review`
    - Render `ResetDemoButton` (passing `demoMode={process.env.DEMO_MODE === 'true'}` as a prop)
    - _Requirements: 4.2, 9.2, 9.3, 13.1_

  - [ ] 15.2 Create `app/bills/[id]/review/page.tsx` (server component)
    - Load the bill record and the full list of vendors server-side via Supabase service role client
    - Pass bill and vendors as props to `BillReviewForm`
    - If the bill status is not `needs_review`, redirect to `/`
    - _Requirements: 4.2_

  - [ ] 15.3 Wire up client-side refresh after processing and correction
    - In `UploadZone`, after all process calls complete, call `router.refresh()` (Next.js App Router) to re-fetch the bill list on the server component
    - In `BillReviewForm`, after a successful correction submission, call `router.refresh()` and redirect to `/`
    - _Requirements: 1.10, 4.7_

- [ ] 16. Manual test checklist document
  - [ ] 16.1 Create `docs/manual-test-checklist.md`
    - Pre-conditions section: seed script run, `DEMO_MODE=true`, `POLICY_LIMIT_MINOR_UNITS=100000` set in `.env.local`, 8 sample images present in `public/samples/`
    - Step-by-step instructions for uploading and processing each of the 8 bills in order: `ready-1.jpg` through `ready-4.jpg`, then `duplicate.jpg`, `overcharge.jpg`, `new-payee.jpg`, `needs-review.jpg`
    - Expected outcome per bill: status value, flags present/absent, flag reason text (using amounts from seed data design table)
    - Reset demo steps: click Reset Demo button → confirm dialog → verify redirect to upload page → verify 0 bills shown
    - _Requirements: 12.3, 12.4, 13.4_

- [ ] 17. Final checkpoint — full integration
  - Ensure all automated tests pass (`vitest --run`). Verify `.env.example` contains all variables with correct placeholder values. Confirm `supabase/seed.sql` contains only `SELECT seed_demo_data();`. Ask the user if any questions arise.

## Notes

- Tasks marked with `*` are optional. Task 13 (mocked API route tests) can be skipped for a faster MVP; all other tests are required.
- All property-based tests use fast-check arbitraries and run via Vitest (`tests/` directory)
- `public/samples/` image files (`ready-1.jpg` … `needs-review.jpg`) are NOT generated by code — they are added manually
- Money is always stored and compared as integer minor units; `formatCurrency` is used exclusively for display
- All write operations use the Supabase service role client; the anon key is never used for writes
- All Postgres RPC functions enforce `REVOKE EXECUTE FROM public, anon, authenticated` / `GRANT EXECUTE TO service_role`
- `reset_demo()` and all SECURITY DEFINER functions have `SET search_path = public`
- `needs_review` transitions always go through `save_extraction()` RPC, never through `transition_bill_status()`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["3.1", "3.2", "4.1", "5.1", "5.2", "5.3", "5.4"] },
    { "id": 1, "tasks": ["3.3", "3.4", "4.2", "4.3", "5.5", "5.6"] },
    { "id": 2, "tasks": ["7.1"] },
    { "id": 3, "tasks": ["7.2", "7.3", "7.4", "8.1", "8.2"] },
    { "id": 4, "tasks": ["8.3"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["10.1"] },
    { "id": 7, "tasks": ["11.1", "12.1"] },
    { "id": 8, "tasks": ["14.1", "14.2", "14.3"] },
    { "id": 9, "tasks": ["14.4", "15.1", "15.2"] },
    { "id": 10, "tasks": ["15.3", "16.1"] }
  ]
}
```
