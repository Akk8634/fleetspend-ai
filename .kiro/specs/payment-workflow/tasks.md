# Implementation Plan: Payment Workflow

## Overview

Add human-approved PayPal Payouts (sandbox) on top of the invoice-processing pipeline: database schema and RPCs for batches and items, a server-only PayPal client, approval/submit/sync logic behind an injectable store, API routes, and the approval UI in the existing bill list. Tests sit next to the code they cover.

## Tasks

- [x] 1. Database: payout tables, state machine, RPCs
  - Create `supabase/migrations/008_payment_workflow.sql`:
    - Extend `bills.status` CHECK with `payout_pending`, `payout_failed`; replace `transition_bill_status` so it no longer allows `ready/flagged → paid`.
    - Extend `audit_log.event` CHECK with `approved`, `payout_status`, `payout_rejected`.
    - Create `payout_batches` and `payout_items` per the design, the partial unique index `uq_payout_items_live_bill`, and a trigger that blocks DELETE and backwards outcome changes on `payout_items`.
    - Create RPCs `approve_and_create_batch`, `mark_batch_submitted`, `mark_batch_rejected`, `apply_payout_sync`; replace `reset_demo` to also truncate payout tables.
    - Enable RLS on new tables (no policies); REVOKE from `public, anon, authenticated`, GRANT EXECUTE to `service_role`; `SET search_path = public` on every function.
  - Verify with PGlite: applies on top of 001–007, re-runnable, rejects a second live item per bill, blocks outcome going backwards, approval rejects atomically, reset clears payout tables.
  - _Requirements: 1.1, 1.3–1.7, 2.6, 3.3, 3.4, 4.1, 4.2, 4.4, 4.5, 6.1–6.3, 7.1_

- [x] 2. PayPal client (`lib/paypal/`)
  - [x] 2.1 `config.ts`: `getPayPalConfig()`; default sandbox base URL; refuse non-sandbox hosts
    - _Requirements: 2.3, 2.4, 7.3_
  - [x] 2.2 `amount.ts`: `centsToPayPalValue(cents)` with integer math
    - _Requirements: 2.1_
  - [x] 2.3 `status.ts`: `toItemOutcome(status)` mapping
    - _Requirements: 3.2_
  - [x] 2.4 `buildPayoutRequest.ts`: pure request builder
    - _Requirements: 2.1, 2.2_
  - [x] 2.5 `client.ts`: OAuth token with cache, `createPayout(request, requestId)` sending `PayPal-Request-Id`, `getPayout(id)`, 30 s timeout, `PayPalApiError` / `PayPalNetworkError`, injectable `fetch`
    - _Requirements: 2.2, 2.3, 2.6, 2.7, 3.1_
  - [x] 2.6 Unit and property tests (`tests/paypal.test.ts`)
    - **Property 7: PayPal amount conversion is exact**
    - **Property 8: Status mapping is total and correct**
    - **Property 9: Payout request preserves money and identity**
    - Token cached until 60 s before expiry; request id header sent; secrets never appear in error messages
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 3. Checkpoint — PayPal layer tests pass

- [x] 4. Payment logic (`lib/payments/`)
  - [x] 4.1 `store.ts`: `PaymentStore` interface and Supabase implementation (RPC calls, batch queries)
    - _Requirements: 1.5, 3.1, 5.2_
  - [x] 4.2 `approveAndPay.ts`: input validation (zod), approval, `submitBatch`, `syncBatch`, `ApprovalRejectedError` parsing `APPROVAL_REJECTED:` problems
    - _Requirements: 1.2–1.7, 2.1–2.7, 3.1–3.8, 4.3_
  - [x] 4.3 Unit tests with in-memory store + fake PayPal (`tests/payments.test.ts`)
    - **Property 10: Outcomes only move forward**
    - Success; PayPal 4xx rejection; network failure then resend with same request id; partial item failure; double submit; approving a paid bill; flagged bill without reason
    - _Requirements: 8.4_

- [x] 5. API routes
  - [x] 5.1 `POST /api/payouts` (approve + pay), `maxDuration = 60`; 400/409/503 handling
    - _Requirements: 1.4–1.7, 2.1–2.7, 7.3_
  - [x] 5.2 `POST /api/payouts/[batchId]/sync`, `maxDuration = 60`
    - _Requirements: 3.1, 3.6–3.8_
  - [x] 5.3 `GET /api/payouts` (10 most recent batches)
    - _Requirements: 5.2_

- [x] 6. UI
  - [x] 6.1 `BillTable` client component: checkboxes for `ready` / `flagged` / `payout_failed`, sticky "Approve & pay $X to N payees" bar, disabled when PayPal is not configured
    - _Requirements: 1.1, 5.1, 7.3_
  - [x] 6.2 `ApprovalDialog`: payees, amounts, total, override reason per flagged bill with its flag reasons; double-click safe; shows 409 problems per bill
    - _Requirements: 1.2, 1.3, 1.4, 4.3_
  - [x] 6.3 Status display for `payout_pending`, `paid` (transaction id), `payout_failed` (reason); "Paid" summary card
    - _Requirements: 5.1, 5.3, 5.4_
  - [x] 6.4 `PaymentsPanel` + `PayoutPoller` (sync every 5 s for at most 2 minutes, then refresh)
    - _Requirements: 3.7, 5.2_

- [x] 7. Configuration and docs
  - Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE` to `.env.example`
  - Extend `docs/manual-test-checklist.md` with the approval and payout steps
  - _Requirements: 7.2_

- [x] 8. Live sandbox check
  - `tests/live-paypal.test.ts` (skipped unless `LIVE_PAYPAL=1`): pay one small ready bill end to end and confirm `paid` + transaction id
  - Run the full demo in the browser: approve 4 ready bills and the overcharge bill (with reason) → all Paid; sandbox personal account balances increase
  - _Requirements: 8.5_

- [ ]* 9. Optional: PayPal webhooks
  - `POST /api/paypal/webhook` verifying signatures via `/v1/notifications/verify-webhook-signature`, then syncing the batch. Needs a public URL (after deploy).

- [x] 10. Final checkpoint — all tests, type-check, lint and build pass

## Notes

- Tasks marked with `*` are optional.
- Money is integer cents everywhere; `centsToPayPalValue` is the only place a decimal string is produced.
- Only the server talks to PayPal. The browser never sees the client secret or access token and never reports a payment as successful.
- Sandbox only: `PAYPAL_API_BASE` must be a sandbox host.
