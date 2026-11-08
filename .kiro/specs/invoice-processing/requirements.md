# Requirements Document

## Introduction

The invoice-processing feature allows fleet business owners to upload one or more bills (JPG, PNG, or PDF), have each bill stored securely, and have its data extracted automatically via AI. Extracted data is validated, checked against four business rules (duplicate, overcharge, new payee, policy limit), and assigned a status of "ready" or "flagged". The feature also seeds demo data so the checks have historical context on first run. Payments and the approval table are out of scope for this spec.

## Glossary

- **System**: The FleetSpend AI application.
- **Upload_Handler**: The API route handler that receives bill file uploads.
- **Storage**: Supabase Storage, where bill files are persisted.
- **Bill**: A database record representing one uploaded invoice, with metadata and a lifecycle status.
- **Extractor**: The Gemini vision client in `lib/ai/` that processes a bill file and returns structured JSON.
- **Validator**: The zod schema layer that checks the Extractor's JSON output before it is used.
- **Check_Engine**: The set of pure functions in `lib/checks/` that evaluate a validated bill against business rules and produce flags.
- **Flag**: A structured object containing a check name and a plain-English reason attached to a Bill.
- **Confidence_Score**: A numeric value (0–1) returned by the Extractor for each extracted field indicating AI certainty.
- **Vendor**: A payee entity with a name and (optionally) a PayPal email address, tracked across bills.
- **Vendor_ID**: A UUID primary key for a vendor record. Used by all checks instead of the raw vendor name.
- **Normalized_Name**: A vendor name with all characters lowercased, leading/trailing whitespace trimmed, punctuation removed, and common legal suffixes (ltd, inc, llc, stn) stripped, used for fuzzy matching during extraction.
- **Minor_Units**: Integer representation of a monetary amount in the smallest currency denomination (e.g., cents for USD). Money is never stored or computed as a floating-point number.
- **Policy_Limit**: A per-bill maximum amount (in Minor_Units) configured at the application level via environment variable.
- **Audit_Log**: An append-only database table that records every Bill status transition.
- **Demo_Seed**: SQL seed data providing five vendors with historical paid bills and eight sample bill images.

## Requirements

### Requirement 1: Bill File Upload

**User Story:** As a fleet owner, I want to upload one or more bill files at once, so that I can submit all invoices from a single session without repeating the process.

#### Acceptance Criteria

1. WHEN a user submits one or more files to the upload endpoint, THE Upload_Handler SHALL accept up to 20 files per request with a combined total size not exceeding 100 MB.
2. WHEN a submitted file's MIME type is not `image/jpeg`, `image/png`, or `application/pdf`, THEN THE Upload_Handler SHALL reject that file with an error message identifying the file name and the unsupported type.
3. WHEN a submitted file exceeds 10 MB in size, THEN THE Upload_Handler SHALL reject that file with an error message identifying the file name and its size.
4. WHEN a file passes type and size validation, THE Upload_Handler SHALL store the file in Storage under a path that includes a UUID and the original file name.
5. WHEN a file is successfully stored, THE Upload_Handler SHALL create a Bill record in the database with status `uploaded`, the Storage path, the original file name, and the upload timestamp.
6. WHEN a Bill record is created, THE System SHALL write an `audit_log` row recording the `uploaded` status transition with the bill ID and timestamp.
7. IF Storage write fails for a file, THEN THE Upload_Handler SHALL return an error for that file, leave no partial Bill record, and continue processing any remaining files in the batch.
8. IF the database write fails after a file has been stored in Storage, THEN THE Upload_Handler SHALL delete the stored file from Storage, return an error for that file identifying the file name, leave no partial Bill record, and continue processing any remaining files in the batch.
9. WHEN a batch request completes processing, THE Upload_Handler SHALL return a single response containing, for each submitted file, either the created Bill record ID and status `uploaded` on success, or an error message identifying the file name and the reason for rejection or failure.
10. WHEN a batch of files is accepted, THE System SHALL process each bill individually via its own server request, triggered in upload order, with each subsequent request issued only after the previous bill's request completes.

---

### Requirement 2: AI Data Extraction

**User Story:** As a fleet owner, I want the system to automatically read each bill and pull out the key details, so that I do not have to type them in manually.

#### Acceptance Criteria

1. IF a Bill record has its status set to `uploaded`, THEN THE Extractor SHALL initiate an extraction job for that Bill by sending the bill file to the Gemini vision model identified by the `GEMINI_MODEL` environment variable.
2. THE Extractor SHALL request a structured JSON response containing exactly these fields for each bill: `vendor_name`, `payee_email` (optional, nullable), `amount_text` (a non-empty string containing the amount exactly as printed on the bill, e.g. `"1,250.50"`), `currency_code`, `bill_date`, `invoice_number` (optional, nullable), `category`, and `confidence` (an object with one numeric score per field in the range 0.0 to 1.0 inclusive, rounded to two decimal places).
3. WHEN the Gemini API returns a response, THE Validator SHALL validate it against the extraction zod schema before any field is persisted or used.
4. IF the Gemini API returns a response that fails zod validation, THEN THE System SHALL set the Bill status to `needs_review` and attach an error message that lists each failing field name and the reason it failed validation, without persisting any partially extracted fields.
5. WHEN the Extractor successfully returns a valid extraction, THE System SHALL match the extracted `vendor_name` to an existing vendor using the Normalized_Name comparison; if a match is found, THE System SHALL link the Bill to that vendor's Vendor_ID; if no match is found, THE System SHALL create a new vendor record and link the Bill to the new Vendor_ID.
6. WHEN the Extractor successfully returns a valid extraction and a Vendor_ID has been resolved, THE System SHALL convert `amount_text` to integer Minor_Units using the currency's standard decimal places (e.g., 2 for USD), then persist all extracted fields and the resolved Vendor_ID to the Bill record and update its status to `extracted`.
7. WHEN a Bill is updated to `extracted`, THE System SHALL write an `audit_log` row that records the Bill ID, the previous status (`uploaded`), the new status (`extracted`), and the UTC timestamp of the transition.
8. THE Extractor SHALL use the `GEMINI_MODEL` environment variable to identify the model and SHALL NOT hard-code any model name.
9. IF the Gemini API call does not return a successful response within 20 seconds or fails with a network or service error, THEN THE Extractor SHALL retry the call up to 1 additional time with a 5-second delay between attempts, and IF all attempts fail, THEN THE System SHALL set the Bill status to `needs_review` and attach an error message that identifies the failure type (timeout or service error) and that both attempts were exhausted.

---

### Requirement 3: Currency Validation

**User Story:** As a fleet owner, I want only USD bills to be processed automatically, so that I am not surprised by currency conversion errors or unsupported payouts.

#### Acceptance Criteria

1. WHEN the Extractor returns a `currency_code` that is not `USD`, THEN THE System SHALL set the Bill status to `needs_review` and attach the reason: "Only USD bills are supported in this version."
2. WHEN the `currency_code` is `USD`, THE System SHALL proceed with amount conversion and further processing.
3. THE currency validation SHALL occur after zod schema validation and before amount conversion.

---

### Requirement 4: Low-Confidence Field Handling

**User Story:** As a fleet owner, I want to be notified when the AI is not sure about a field, so that I can correct mistakes before the bill is processed further.

#### Acceptance Criteria

1. WHEN any of the fields `vendor_name`, `amount_text`, `currency_code`, or `bill_date` has a Confidence_Score below 0.8, THE System SHALL set the Bill status to `needs_review` and store the identifiers of all such fields whose Confidence_Score is below 0.8. The optional fields `payee_email` and `invoice_number` SHALL NOT trigger `needs_review` regardless of their confidence score.
2. IF a Bill has status `needs_review`, THEN THE System SHALL display a form in the UI that pre-fills all extracted fields and visually distinguishes the fields whose Confidence_Score is below 0.8 from fields that meet or exceed the threshold; the form SHALL also include a vendor selector control that allows the owner to pick an existing vendor or confirm the matched vendor. All monetary amounts displayed in the review form SHALL be shown as formatted currency strings (e.g. `$450.00`), not as Minor_Units integers.
3. WHEN the owner submits corrected fields for a `needs_review` Bill, THE System SHALL validate that: vendor name is non-empty and at most 255 characters, currency code is a valid ISO 4217 alphabetic code, amount is a positive decimal number with at most 2 decimal places (e.g. `125.50`), and date is a calendar-valid date in YYYY-MM-DD format; and if all validations pass, THE System SHALL update the Bill record with the submitted values.
4. IF validation of the submitted correction fails, THEN THE System SHALL reject the submission, preserve the previously stored field values unchanged, and return an error message indicating which field failed validation and the reason.
5. WHEN the owner submits a corrected amount, THE System SHALL convert the submitted decimal string to Minor_Units using the same conversion function used for AI-extracted `amount_text`, and SHALL reject values that are not valid decimal numbers with at most 2 decimal places or that would convert to a Minor_Units value outside the range 1 to 999,999,999 inclusive.
6. WHEN the owner submits corrected fields, THE System SHALL validate that the `currency_code` is `USD`; if it is not, THE System SHALL reject the submission with the reason "Only USD bills are supported in this version."
7. WHEN manual corrections are saved, THE System SHALL write an `audit_log` row containing the Bill identifier, the actor identity `"demo_owner"`, the timestamp of the correction, the name of each corrected field, the prior value, and the new value, then proceed to run the Check_Engine on the corrected Bill.
8. IF `payee_email` is absent or null in the extracted fields, THEN THE System SHALL fall back to the vendor's stored PayPal email address from the matched or newly created vendor record.

---

### Requirement 5: Duplicate Check

**User Story:** As a fleet owner, I want the system to catch duplicate invoices, so that I never pay the same bill twice.

#### Acceptance Criteria

1. WHEN the Check_Engine runs the duplicate check for a Bill, THE Check_Engine SHALL compare the Bill's `vendor_id` and `invoice_number` against all existing Bills whose status is not `uploaded` or `needs_review`.
2. WHEN the Check_Engine runs the duplicate check for a Bill, THE Check_Engine SHALL also compare the Bill's `vendor_id`, `amount_minor_units`, and `bill_date` against all existing Bills whose status is not `uploaded` or `needs_review`.
3. WHEN either comparison in criteria 1 or 2 produces at least one match, THE Check_Engine SHALL attach a `duplicate` Flag to the Bill; the Flag reason SHALL reference the earliest-matched Bill in the form: "Possible duplicate of invoice [invoice_number] from [vendor_name] on [bill_date]."
4. WHEN both comparisons in criteria 1 and 2 produce matches, THE Check_Engine SHALL attach exactly one `duplicate` Flag (not two), referencing the earliest-matched Bill across both result sets.
5. THE duplicate check SHALL be a pure function: given the same Bill fields and the same list of existing bills, it SHALL always return the same Flag result.
6. THE duplicate check SHALL NOT produce a Flag when comparing a Bill against itself (identified by Bill ID).

---

### Requirement 6: Overcharge Check

**User Story:** As a fleet owner, I want to be alerted when a bill amount is unusually high for a vendor, so that I can catch billing errors or fraud.

#### Acceptance Criteria

1. WHEN the Check_Engine runs the overcharge check for a Bill, THE Check_Engine SHALL retrieve the count and sum of `amount_minor_units` for all paid Bills linked to the same `vendor_id` and `currency_code`.
2. WHEN `bill.amount_minor_units * count > 2 * sum` (evaluated using integer arithmetic with no division), THE Check_Engine SHALL attach an `overcharge` Flag with a reason in the form: "Amount of $[amount] is more than 2x the usual $[average] average for [vendor_name]." where `[amount]` and `[average]` are formatted as decimal dollars (e.g. `$450.00`). Note: `[average]` is `sum / count` formatted as a decimal dollar amount for display only; the overcharge threshold comparison still uses `amount * count > 2 * sum` in integer arithmetic without division in storage.
3. WHEN fewer than 2 paid Bills exist for the vendor and currency, THE Check_Engine SHALL NOT attach an `overcharge` Flag (insufficient history).
4. THE overcharge check SHALL be a pure function: given the same Bill amount, the same count, and the same sum of historical paid amounts, it SHALL always return the same Flag result.
5. THE overcharge check SHALL operate exclusively on Minor_Units integers; all intermediate calculations SHALL use integer arithmetic and SHALL NOT introduce floating-point values at any step.
6. THE formatted display amounts in flag reasons and the UI SHALL be computed by a shared currency formatting function that converts Minor_Units integers to a string in the form `$X.XX` (two decimal places, USD). This function SHALL be used consistently for all displayed amounts throughout the feature.

---

### Requirement 7: New Payee Check

**User Story:** As a fleet owner, I want to know when a vendor has never been paid before, so that I can verify new payees before sending money.

#### Acceptance Criteria

1. WHEN the Check_Engine runs the new-payee check for a Bill, THE Check_Engine SHALL determine whether any Bill linked to the same `vendor_id` has ever reached status `paid`.
2. WHEN no paid Bill exists for the vendor, THE Check_Engine SHALL attach a `new_payee` Flag with the reason: "First-time payee: [vendor_name] has no payment history."
3. WHEN at least one paid Bill exists for the vendor, THE Check_Engine SHALL NOT attach a `new_payee` Flag.
4. THE new-payee check SHALL be a pure function: given the same Vendor_ID and the same set of known paid Vendor_IDs, it SHALL always return the same Flag result.

---

### Requirement 8: Policy Limit Check

**User Story:** As a fleet owner, I want bills that exceed my configured per-bill spending limit to be flagged automatically, so that unusual expenses get my attention.

#### Acceptance Criteria

1. THE System SHALL read the per-bill policy limit from the `POLICY_LIMIT_MINOR_UNITS` environment variable as a positive integer at application startup; IF the variable is absent, zero, negative, or non-integer, THEN THE System SHALL log a configuration error and disable the policy-limit check for all bills processed in that session.
2. WHEN the Check_Engine runs the policy-limit check for a Bill whose `amount_minor_units` is strictly greater than the configured `POLICY_LIMIT_MINOR_UNITS`, THE Check_Engine SHALL attach a `policy_limit` Flag with a reason in the form: "Amount of $[amount] is above your per-bill limit of $[limit]." where both values are formatted as decimal dollars (e.g. `$1,250.00`).
3. WHEN a Bill's `amount_minor_units` is less than or equal to `POLICY_LIMIT_MINOR_UNITS`, THE Check_Engine SHALL NOT attach a `policy_limit` Flag.
4. THE policy-limit check SHALL be a pure function: given the same amount integer and the same limit integer, it SHALL always return the same Flag result.

---

### Requirement 9: Bill Status Assignment After Checks

**User Story:** As a fleet owner, I want each bill to have a clear status after checks run, so that I can immediately see which bills need my attention and which are ready to approve.

#### Acceptance Criteria

1. WHEN the Check_Engine completes all four checks (duplicate, overcharge, new_payee, policy_limit) for a Bill, THE System SHALL collect the complete list of resulting Flags before updating the Bill status.
2. WHEN the collected Flag list is empty, THE System SHALL set the Bill status to `ready`.
3. WHEN the collected Flag list contains one or more Flags, THE System SHALL set the Bill status to `flagged`.
4. WHEN the Bill status is set to `flagged`, THE System SHALL persist each Flag as a separate record associated with the Bill, storing the check name and the plain-English reason.
5. WHEN the Bill status is updated to `ready` or `flagged`, THE System SHALL write an `audit_log` row containing: the Bill ID, the new status, the UTC timestamp, and an array of check names that produced flags (empty array for `ready`).
6. IF one bill's processing request fails, THE System SHALL record the error for that bill and continue issuing requests for the remaining bills in upload order.

---

### Requirement 10: Check Engine Property-Based Tests

**User Story:** As a developer, I want the four business-rule checks covered by property-based tests, so that edge cases in money arithmetic and flag logic are caught automatically.

#### Acceptance Criteria

1. THE Check_Engine's duplicate check SHALL have a property-based test asserting: for any Bill and any list of existing bills where no entry matches the Bill's (`vendor_id` + `invoice_number`) OR (`vendor_id` + `amount_minor_units` + `bill_date`) combination, the check returns no flag.
2. THE Check_Engine's overcharge check SHALL have a property-based test asserting: for any positive integer Bill amount, any positive integer count ≥ 2, and any positive integer sum where `amount * count ≤ 2 * sum`, the check returns no flag.
3. THE Check_Engine's overcharge check SHALL have a property-based test asserting: for any positive integer Bill amount, any positive integer count ≥ 2, and any positive integer sum where `amount * count > 2 * sum`, the check returns an `overcharge` flag.
4. THE Check_Engine's policy-limit check SHALL have a property-based test asserting: for any positive integer amount and any positive integer limit where `amount > limit`, the check returns a `policy_limit` flag; where `amount ≤ limit`, it returns no flag.
5. THE Check_Engine's new-payee check SHALL have a property-based test asserting: for any Vendor_ID not present in the set of paid Vendor_IDs, the check returns a `new_payee` flag; for any Vendor_ID present in the set, it returns no flag.
6. THE amount conversion function SHALL have a property-based test asserting: for any valid `amount_text` string (digits, optional thousands-separator commas, optional decimal point with the correct number of decimal places for the currency), the conversion to Minor_Units is exact and lossless (i.e., converting back to a decimal string produces the original amount).
7. ALL property-based tests SHALL use fast-check arbitraries, be located in `tests/`, and SHALL run via Vitest without requiring any external service.

---

### Requirement 11: Audit Log Integrity

**User Story:** As a fleet owner, I want every change to a bill's status to be recorded permanently, so that I have a full history I can trust.

#### Acceptance Criteria

1. THE System SHALL write exactly one `audit_log` row for each of the following events: Bill status set to `uploaded`, `extracted`, `needs_review`, `ready`, or `flagged`; and for each manual field correction event.
2. Normal application code SHALL never issue UPDATE, DELETE, or TRUNCATE statements targeting the `audit_log` table; the DB-level trigger (criterion 7) enforces this for UPDATE and DELETE. The only permitted exception is the Reset Demo Postgres function (see Requirement 13).
3. WHEN an `audit_log` row is written for a status transition event, THE System SHALL include: the Bill ID (UUID), the previous status, the new status, and the UTC timestamp of the transition.
4. WHEN an `audit_log` row is written for a manual correction event, THE System SHALL include: the Bill ID (UUID), the event name `field_corrected`, the UTC timestamp, an array of corrected field names, and for each corrected field the prior value and the new value.
5. IF writing an `audit_log` row fails, THEN THE System SHALL roll back the associated Bill status transition or field update, surface an error to the caller indicating that the audit write failed, and SHALL NOT leave the Bill in the new state without a corresponding audit record.
6. EACH Bill status change and its corresponding `audit_log` row SHALL be written in a single Postgres transaction, implemented as a Postgres function called via Supabase RPC.
7. THE `audit_log` table SHALL enforce append-only behavior at the database level via a Postgres trigger that blocks any UPDATE or DELETE DML statement and raises an exception. TRUNCATE on `audit_log` is only permitted when executed by the SECURITY DEFINER reset function described in Requirement 13, which bypasses row-level triggers.

---

### Requirement 12: Demo Seed Data

**User Story:** As a demo user, I want pre-loaded vendors and historical bills when I first open the app, so that the AI checks have real history to work with and I can see the product without manual setup.

#### Acceptance Criteria

1. THE System SHALL include a `supabase/seed.sql` file that inserts exactly 5 vendors with distinct names, distinct categories drawn from (fuel, repair, parts, driver_trip, other), and distinct PayPal sandbox email addresses in the format `*@example.com`.
2. THE System SHALL seed at least 3 paid Bills per vendor (15 paid Bills total minimum), each with a realistic `amount_minor_units` value between 500 and 500,000, a `currency_code` of `USD`, a `bill_date` in the 12 months preceding the seed script's reference date, and a unique `invoice_number`.
3. THE `public/samples/` directory SHALL contain exactly 8 bill image files (JPG or PNG) added manually; the implementation tasks SHALL NOT generate or create these files. Each file's name SHALL document which demo scenario it represents: `ready-1.jpg`, `ready-2.jpg`, `ready-3.jpg`, `ready-4.jpg`, `duplicate.jpg`, `overcharge.jpg`, `new-payee.jpg`, `needs-review.jpg`.
4. THE 8 sample bills SHALL map to exactly these demo scenarios when processed against the seed data: 4 bills that result in status `ready` (no flags); 1 bill that triggers a `duplicate` flag (matches a seeded paid bill's vendor and invoice number, or vendor, amount, and date); 1 bill that triggers an `overcharge` flag (its amount satisfies `amount * count > 2 * sum` for that vendor's seeded paid bill history); 1 bill from a vendor not present in the seed data (triggers a `new_payee` flag); and 1 low-quality or ambiguous bill where at least one of `vendor_name`, `amount_text`, `currency_code`, or `bill_date` has a Confidence_Score below 0.8, resulting in status `needs_review`.
5. THE seed data (vendors and paid bills) SHALL be numerically consistent with the demo scenarios: the overcharge scenario bill's amount SHALL actually satisfy the integer inequality `amount * count > 2 * sum` given the seeded paid amounts for that vendor.
6. IF the application is running in demo mode (the `DEMO_MODE` environment variable is set to `true`), THEN THE System SHALL display the seeded vendor and bill data on first load without requiring the user to sign in or run any command other than the documented seed script.
7. THE seed data SHALL NOT include any real PayPal credentials, real invoice numbers from actual companies, or any value that constitutes personally identifiable information as defined by GDPR Article 4.

---

### Requirement 13: Reset Demo

**User Story:** As a demo user, I want to reset the app back to its initial seeded state, so that I can re-run the demo from scratch without manual database intervention.

#### Acceptance Criteria

1. THE System SHALL expose a "Reset demo" action in the UI as a clearly labeled button.
2. WHEN the owner triggers "Reset demo", THE System SHALL invoke a single SECURITY DEFINER Postgres function that: (a) uses TRUNCATE to clear the `audit_log`, `flags`, and `bills` tables; (b) deletes all uploaded files from Storage; (c) re-runs the seed inserts to restore the 5 vendors and their paid bills and the corresponding audit_log rows. This function is the only database path permitted to TRUNCATE `audit_log`.
3. THE SECURITY DEFINER reset function SHALL verify that the `DEMO_MODE` environment variable is set to `true` before executing; if it is not, the function SHALL raise an exception and make no changes.
4. WHEN the reset completes, THE System SHALL display a confirmation message and redirect to the upload page.
5. THE reset action SHALL only be available when `DEMO_MODE=true`.
6. THE reset action SHALL be implemented as a single server action or API route that runs all deletions and re-seeding in one Postgres transaction where possible.
