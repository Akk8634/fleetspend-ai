# Requirements Document

## Introduction

The approval-agent feature gives the fleet owner two faster ways to decide what to pay: an **AG Grid approval table** for sorting, filtering and selecting bills, and an **AI Payment Assistant** that turns a plain-English instruction ("Pay all clean fuel bills from this week") into a **payment plan**. The assistant is agentic but bounded: the AI only translates the instruction into structured selection criteria; deterministic code applies those criteria to the bills, enforces guardrails, and explains every inclusion and exclusion. The plan never pays anything: the Owner reviews it and confirms through the existing human approval dialog (payment-workflow spec), which still requires a typed reason for every flagged bill.

## Glossary

- **Approval_Table**: The AG Grid Community grid that lists the Owner's bills and holds the payment selection.
- **Payment_Assistant**: The UI panel and server endpoint that turn an Instruction into a Payment_Plan.
- **Instruction**: The Owner's plain-English request, 3–300 characters.
- **Plan_Criteria**: Structured JSON produced by Gemini from the Instruction: vendor names, categories, date range, per-bill maximum, plan total maximum, whether flagged bills and failed retries may be included, plus a one-sentence summary. Or a clarification question when the Instruction is ambiguous.
- **Plan_Engine**: A pure function that applies Plan_Criteria and guardrails to the payable bills and returns a Payment_Plan.
- **Payment_Plan**: The included bills (each with a reason), the excluded candidate bills (each with a reason), the total, the number of payees and the interpreted criteria.
- **Plan_Cap**: A system-wide maximum total for one plan: $5,000.00.
- **Payable bill**: A bill with status `ready`, `flagged` or `payout_failed` (payment-workflow spec).

## Requirements

### Requirement 1: AG Grid Approval Table

**User Story:** As a fleet owner, I want a fast, sortable table of my bills, so that I can find and select what to pay without scrolling through cards.

#### Acceptance Criteria

1. THE Approval_Table SHALL be built with AG Grid Community and show one row per uploaded bill with columns: Vendor, Invoice, Bill date, Amount, Status, Checks (flag labels and reasons, or the needs-review / payment message), and Payee.
2. THE Approval_Table SHALL support sorting on every column, a text filter on Vendor and Invoice, a quick search box across all columns, and status filter chips: All, Ready, Flagged, Needs review, Paying, Paid, Failed.
3. THE Approval_Table SHALL allow selecting only payable bills (`ready`, `flagged`, `payout_failed`); checkboxes for other rows SHALL be hidden, and the header checkbox SHALL select only payable rows that pass the current filter.
4. THE Approval_Table SHALL show a footer with the number of selected bills and their total, and an "Approve & pay" button that opens the existing approval dialog for exactly the selected bills.
5. THE Amount column SHALL display `formatCurrency` values and sort by integer cents.
6. THE Status column SHALL render the existing status badge; rows needing review SHALL have a "Review" link to the review page.
7. THE Approval_Table SHALL remain usable at 375 px width by scrolling horizontally inside the grid while the page itself does not scroll horizontally.
8. IF PayPal is not configured, THEN THE Approval_Table SHALL hide selection and show "PayPal is not configured".

---

### Requirement 2: Instruction to Plan_Criteria

**User Story:** As a fleet owner, I want to tell the assistant what to pay in my own words, so that I don't have to pick bills one by one.

#### Acceptance Criteria

1. WHEN the Owner submits an Instruction of 3–300 characters, THE Payment_Assistant SHALL send it to the Gemini model in `GEMINI_MODEL` with today's date and the list of known vendor names and categories, using JSON mode with a response schema, and SHALL validate the response with zod.
2. THE Plan_Criteria SHALL contain only: `intent` (`plan` or `clarify`), `clarification_question`, `vendor_names`, `categories`, `date_from`, `date_to`, `max_amount_per_bill` (decimal text), `max_total` (decimal text), `include_flagged` (boolean), `include_failed` (boolean), and `summary`.
3. THE Payment_Assistant SHALL never accept bill ids, payee emails or amounts to pay from the AI; only the criteria fields above are used.
4. WHEN Gemini returns `intent = clarify`, THE Payment_Assistant SHALL show the clarification question and SHALL NOT produce a plan.
5. IF Gemini fails, times out after 20 seconds, or returns data that fails validation, THEN THE Payment_Assistant SHALL show "The assistant could not understand that. Try rephrasing, e.g. 'Pay all clean fuel bills from this week'." and SHALL NOT change the selection.
6. Relative dates such as "this week", "last month" or "today" SHALL be resolved by the AI against the server's current date, and the resolved dates SHALL be shown to the Owner.

---

### Requirement 3: Plan_Engine and Guardrails

**User Story:** As a fleet owner, I want the assistant to follow strict safety rules, so that it can never suggest something risky without me noticing.

#### Acceptance Criteria

1. THE Plan_Engine SHALL consider only payable bills and SHALL never include a bill in any other status.
2. THE Plan_Engine SHALL include a `flagged` bill only when `include_flagged` is true, and SHALL include a `payout_failed` bill only when `include_failed` is true; otherwise it SHALL list them under excluded with the reason ("Flagged: duplicate — not included unless you ask for flagged bills").
3. THE Plan_Engine SHALL apply vendor (normalized name match), category, date range (inclusive) and per-bill maximum filters; a bill that fails a filter but would otherwise be payable SHALL NOT appear in the excluded list, to keep it short (only near-misses are listed: flagged, failed, over-limit, over-cap).
4. THE Plan_Engine SHALL add bills oldest-first (then smallest amount first) and SHALL stop adding when the next bill would exceed the smaller of `max_total` and the Plan_Cap; each skipped bill SHALL be excluded with reason "Would exceed the plan limit of $X".
5. THE Plan_Engine SHALL be a pure, deterministic function: the same bills, criteria and caps always produce the same plan.
6. THE Payment_Plan SHALL include, for each included bill, a one-line reason built from the criteria (e.g. "Fuel · Nov 4 · passed all checks").
7. THE Payment_Plan total SHALL be computed in integer cents and SHALL equal the sum of included bill amounts.

---

### Requirement 4: Human Approval of a Plan

**User Story:** As a fleet owner, I want to review the assistant's plan and approve it myself, so that the AI never moves money on its own.

#### Acceptance Criteria

1. THE Payment_Assistant SHALL show the plan: the AI's summary, the interpreted criteria as readable chips (e.g. "Fuel", "Nov 2 – Nov 8, 2026", "Up to $1,000.00"), the included bills with reasons, the total and payee count, and the excluded bills with reasons.
2. WHEN the Owner clicks "Select these bills", THE Approval_Table SHALL replace its selection with exactly the plan's included bills; the Owner MAY change the selection before approving.
3. Approving SHALL use the existing approval dialog and `POST /api/payouts`; flagged bills SHALL still require a typed Override_Reason.
4. WHEN a payment is approved from a plan, THE System SHALL store the Instruction and the AI summary on the payout batch (`source = 'assistant'`) and in each bill's `approved` audit row; batches approved manually SHALL have `source = 'manual'`.
5. THE Payment_Assistant SHALL state clearly in the UI: "The assistant only suggests. Nothing is paid until you approve."

---

### Requirement 5: Database Changes

#### Acceptance Criteria

1. Migration `009_assistant_plans.sql` SHALL add `source` (`manual` | `assistant`, default `manual`), `assistant_instruction` (≤ 300 chars) and `assistant_summary` (≤ 500 chars) to `payout_batches`.
2. `approve_and_create_batch` SHALL accept an optional `p_plan jsonb` (`{instruction, summary}`), store it on the batch, and copy it into each `approved` audit row; the previous 3-argument signature SHALL be dropped so there is exactly one function.
3. All new and changed functions SHALL keep `SET search_path = public` and `service_role`-only execute permission.

---

### Requirement 6: Tests

1. Property-based tests for the Plan_Engine: (a) every included bill is payable and passes every criterion; (b) flagged / failed bills appear only when allowed; (c) the total equals the sum of included amounts and never exceeds min(max_total, Plan_Cap); (d) the result is deterministic and independent of input order.
2. Unit tests for the Instruction → Plan flow with a fake Gemini: plan, clarify, invalid JSON, timeout, and an attempt by the AI to return bill ids (ignored).
3. A live test, skipped unless `LIVE_GEMINI=1`, that turns three sample instructions into the expected criteria.
