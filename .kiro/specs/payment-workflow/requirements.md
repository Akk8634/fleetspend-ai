# Requirements Document

## Introduction

The payment-workflow feature lets the fleet owner approve checked bills and pay every payee in one PayPal Payouts batch (sandbox). It builds on the invoice-processing spec: bills that are `ready` (all checks passed) or `flagged` (owner overrides with a written reason) can be approved. Approval is always an explicit human action; the AI never moves money. The system creates one payout batch per approval, tracks each payout item's status from PayPal, marks bills `paid` only when PayPal confirms success, and makes it impossible to pay the same bill twice. An AG Grid approval table and the AI payment-plan agent are out of scope for this spec (spec 3).

## Glossary

- **System**: The FleetSpend AI application.
- **Owner**: The single demo user (`demo_owner`) who approves payments. There is no login in this version.
- **Approval**: The Owner's explicit action of selecting one or more bills and confirming payment.
- **Override_Reason**: A short text the Owner must type to approve a `flagged` bill (e.g. "Called Apex, price increase confirmed").
- **Payout_Batch**: One PayPal Payouts request created from one Approval. Its local UUID is sent to PayPal as `sender_batch_id`.
- **Payout_Item**: One payment inside a Payout_Batch, for exactly one bill. Its local UUID is sent as `sender_item_id`.
- **PayPal_Client**: Server-side module in `lib/paypal/` that obtains OAuth tokens and calls the PayPal Payouts REST API (sandbox).
- **Item_Outcome**: The System's normalized view of a PayPal item status: `queued` (not yet sent), `pending`, `success`, or `failed`.
- **Minor_Units**: Integer cents (as in the invoice-processing spec). Converted to a PayPal decimal string only at the API boundary.
- **Status_Sync**: Fetching a batch's current status from PayPal and applying it to local records.

## Requirements

### Requirement 1: Selecting and Approving Bills

**User Story:** As a fleet owner, I want to select bills and approve paying them in one step, so that I can pay all my vendors quickly while staying in control.

#### Acceptance Criteria

1. THE System SHALL allow the Owner to select bills whose status is `ready`, `flagged`, or `payout_failed`, and SHALL NOT allow selecting bills in any other status.
2. WHEN the Owner starts an Approval, THE System SHALL show a confirmation listing each selected bill's vendor, payee PayPal email, and amount, plus the total amount and number of payees, before any payment is created.
3. WHEN a selected bill has status `flagged`, THE System SHALL require a non-empty Override_Reason of at most 500 characters for that bill and SHALL show the bill's flag reasons next to the input.
4. IF any selected bill has no payee email, a non-USD currency, or no amount, THEN THE System SHALL reject the whole Approval with a message naming each problem bill, and SHALL NOT create a Payout_Batch.
5. WHEN the Owner confirms an Approval, THE System SHALL, in one database transaction, create a Payout_Batch with one Payout_Item per bill, move every bill to status `payout_pending`, and write one `audit_log` row per bill with event `approved`, actor `demo_owner`, the batch id and any Override_Reason.
6. IF any selected bill's status changed since it was shown (for example it is already `payout_pending` or `paid`), THEN THE System SHALL reject the whole Approval and leave every bill unchanged.
7. THE System SHALL accept at most 50 bills in one Approval.

---

### Requirement 2: Sending the Payout to PayPal

**User Story:** As a fleet owner, I want approved bills to be paid through PayPal, so that each vendor receives money in their PayPal account.

#### Acceptance Criteria

1. WHEN a Payout_Batch is created, THE PayPal_Client SHALL send one Create Payout request (`POST /v1/payments/payouts`) to the PayPal sandbox containing one item per Payout_Item with `recipient_type` `EMAIL`, the payee email as `receiver`, the amount as a decimal string with exactly two decimals and currency `USD`, the Payout_Item id as `sender_item_id`, and a note naming the vendor and invoice number.
2. THE PayPal_Client SHALL use the Payout_Batch id as `sender_batch_id` and as the `PayPal-Request-Id` header, so that repeating the request can never create a second payout.
3. THE PayPal_Client SHALL obtain an OAuth2 access token with the client-credentials grant using `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, cache it until 60 seconds before it expires, and SHALL never send the client secret or token to the browser or write them to logs.
4. THE PayPal_Client SHALL call only the sandbox base URL `https://api-m.sandbox.paypal.com`, taken from `PAYPAL_API_BASE` with that value as the default.
5. WHEN PayPal accepts the batch, THE System SHALL store the returned `payout_batch_id` and batch status on the Payout_Batch.
6. IF PayPal rejects the request (HTTP 4xx), THEN THE System SHALL mark the Payout_Batch `failed` with PayPal's error name and message, mark every item `failed`, and move every bill to `payout_failed`, writing one `audit_log` row per bill.
7. IF the request times out after 30 seconds or fails with a network error or HTTP 5xx, THEN THE System SHALL leave the batch in status `submitting` and its bills in `payout_pending`, so that a later Status_Sync can safely resend the same request with the same `PayPal-Request-Id`.

---

### Requirement 3: Tracking Payout Status

**User Story:** As a fleet owner, I want to see whether each payment went through, so that I know which vendors have been paid.

#### Acceptance Criteria

1. WHEN a Status_Sync runs for a batch that has a `payout_batch_id`, THE System SHALL fetch the batch from PayPal (`GET /v1/payments/payouts/{payout_batch_id}`) and update the batch status and every item's PayPal item id, transaction id, PayPal transaction status, and Item_Outcome in one database transaction.
2. THE System SHALL map PayPal item statuses to Item_Outcome as follows: `SUCCESS` → `success`; `PENDING`, `ONHOLD`, `UNCLAIMED`, `NEW` → `pending`; `FAILED`, `RETURNED`, `BLOCKED`, `REFUNDED`, `REVERSED`, `DENIED`, `CANCELED` → `failed`; any other value → `pending`.
3. WHEN an item's Item_Outcome becomes `success`, THE System SHALL move its bill to `paid` and record the PayPal transaction id on the bill's audit row.
4. WHEN an item's Item_Outcome becomes `failed`, THE System SHALL move its bill to `payout_failed` and store a plain-English reason (PayPal's error message when available).
5. THE System SHALL only change a bill's status based on data fetched by the server from PayPal, never based on values sent from the browser.
6. WHEN a Status_Sync runs for a batch still in status `submitting` (no `payout_batch_id`), THE System SHALL resend the original Create Payout request with the same `PayPal-Request-Id` and continue as in Requirement 2.
7. THE System SHALL run a Status_Sync immediately after a batch is accepted and SHALL let the Owner trigger a Status_Sync for any batch that is not finished. The UI SHALL refresh pending batches automatically every 5 seconds for at most 2 minutes.
8. WHEN every item in a batch has Item_Outcome `success` or `failed`, THE System SHALL treat the batch as finished and SHALL NOT call PayPal for it again.

---

### Requirement 4: No Double Payments

**User Story:** As a fleet owner, I want to be certain that no bill is ever paid twice, so that I never lose money through a mistake or a double click.

#### Acceptance Criteria

1. THE System SHALL enforce at the database level that a bill can have at most one Payout_Item whose Item_Outcome is `queued`, `pending`, or `success`.
2. THE System SHALL never include a bill with status `payout_pending` or `paid` in a new Approval.
3. WHEN the Owner double-clicks the approve button or resubmits the same Approval, THE System SHALL create at most one Payout_Batch for those bills.
4. WHEN a bill is in `payout_failed`, THE System SHALL allow it to be approved again, which creates a new Payout_Item in a new Payout_Batch; the earlier failed item remains for the record.
5. THE System SHALL extend the bill state machine with exactly these transitions: `ready` → `payout_pending`; `flagged` → `payout_pending` (only with an Override_Reason); `payout_failed` → `payout_pending`; `payout_pending` → `paid`; `payout_pending` → `payout_failed`. The earlier direct transitions `ready` → `paid` and `flagged` → `paid` SHALL be removed.

---

### Requirement 5: Payment Visibility in the UI

**User Story:** As a fleet owner, I want to see payment progress and history next to my bills, so that I can answer "did we pay this?" instantly.

#### Acceptance Criteria

1. THE bill list SHALL show `payout_pending` bills as "Paying…", `paid` bills as "Paid" with the PayPal transaction id, and `payout_failed` bills as "Payment failed" with the reason and a way to select them again.
2. THE home page SHALL show a "Payments" section listing the 10 most recent Payout_Batches with: created time, number of payees, total amount, PayPal batch id, batch status, and a "Refresh status" action for unfinished batches.
3. THE summary cards SHALL include the total amount paid.
4. All amounts SHALL be displayed with the shared `formatCurrency` function.

---

### Requirement 6: Audit Trail

**User Story:** As a fleet owner, I want every approval and payment result recorded, so that I have a trustworthy history.

#### Acceptance Criteria

1. THE System SHALL write one `audit_log` row for each of: approval of a bill (event `approved`), each bill status change caused by a Status_Sync, and a batch-level PayPal rejection.
2. Approval audit rows SHALL include the Override_Reason when the bill was `flagged`, and the list of check names that were overridden.
3. Payout tables SHALL follow the same append-only rule for history: Payout_Items are never deleted by application code; their outcome may only move from `queued` to `pending`, `success` or `failed`, or from `pending` to `success` or `failed`.

---

### Requirement 7: Demo Reset and Configuration

**User Story:** As a demo user, I want the payment data reset along with the bills, so that the demo can be repeated.

#### Acceptance Criteria

1. THE `reset_demo()` function SHALL also clear Payout_Batches and Payout_Items.
2. `.env.example` SHALL list `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
3. IF `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` is missing, THEN THE System SHALL disable approval in the UI with the message "PayPal is not configured" and SHALL return HTTP 503 from the payout endpoints.

---

### Requirement 8: Tests

**User Story:** As a developer, I want the money-moving code covered by tests, so that payment mistakes are caught before a demo.

#### Acceptance Criteria

1. The cents-to-PayPal-amount conversion SHALL have a property-based test: for any integer 1..999,999,999 the produced string matches `^\d+\.\d{2}$` and parsing it back with `parseAmountText` returns the same integer.
2. The PayPal status mapping SHALL have a property-based test: every possible input string maps to exactly one Item_Outcome, and the known statuses map as listed in Requirement 3.2.
3. The payout request builder SHALL have a property-based test: for any non-empty list of approved bills, the request has one item per bill, every `sender_item_id` is unique, and the sum of item amounts equals the batch total in cents.
4. The approval and sync logic SHALL be unit-tested with an in-memory store and a fake PayPal client, covering: success, PayPal 4xx rejection, network failure then successful resend, partial item failure, double submit, and attempting to approve a `paid` bill.
5. A live sandbox test, skipped unless `LIVE_PAYPAL=1`, SHALL pay one small bill end to end and confirm the bill becomes `paid`.
