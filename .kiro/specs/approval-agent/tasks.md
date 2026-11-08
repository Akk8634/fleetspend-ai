# Implementation Plan: Approval Table and Payment Assistant

## Tasks

- [x] 1. Database: assistant plan metadata
  - `supabase/migrations/009_assistant_plans.sql`: new `payout_batches` columns; replace `approve_and_create_batch` with the 4-argument version storing plan metadata; permissions unchanged.
  - PGlite check on top of 001–008.
  - _Requirements: 4.4, 5.1–5.3_

- [x] 2. Plan_Engine (`lib/assistant/planEngine.ts`)
  - [x] 2.1 Criteria types and `buildPlan` per design (pure, cents only)
    - _Requirements: 3.1–3.7_
  - [x] 2.2 Property tests (`tests/planEngine.test.ts`)
    - **Property 11: Plans only contain safe, matching, payable bills**
    - **Property 12: Plan totals are exact and capped**
    - **Property 13: Plans are deterministic**
    - _Requirements: 6.1_

- [x] 3. Instruction → criteria (`lib/assistant/`)
  - [x] 3.1 `prompt.ts`, `criteriaSchema.ts` (zod + Gemini JSON schema)
  - [x] 3.2 `generateCriteria.ts` (Gemini JSON mode, 20 s timeout) and `planPayment.ts` orchestration with injectable dependencies
  - [x] 3.3 Unit tests with fake Gemini (`tests/assistant.test.ts`)
  - _Requirements: 2.1–2.6, 6.2_

- [x] 4. API
  - [x] 4.1 `POST /api/assistant/plan`
  - [x] 4.2 Extend payouts approval (`approvalSchema`, store, route) with optional `plan`
  - _Requirements: 2.5, 4.3, 4.4_

- [x] 5. UI
  - [x] 5.1 `BillGrid` (AG Grid Community): columns, sorting, filters, quick search, status chips, payable-only selection, footer total
    - _Requirements: 1.1–1.8_
  - [x] 5.2 `PaymentAssistant` panel: input, examples, plan card, clarify / error states, "Select these bills"
    - _Requirements: 4.1, 4.2, 4.5_
  - [x] 5.3 `ApprovalWorkspace` wiring selection between grid, assistant and the approval dialog (plan metadata passed when unchanged)
    - _Requirements: 4.2–4.4_

- [x] 6. Live checks
  - `tests/live-assistant.test.ts` (`LIVE_GEMINI=1`)
  - Browser: the three demo instructions; approve one plan and confirm the batch shows source = assistant
  - _Requirements: 6.3_

- [ ] 7. Final checkpoint — tests, type-check, lint, build; deploy and re-check the live site

## Notes

- The AI produces criteria only. Bill selection, limits and guardrails are deterministic code; payment needs the Owner's approval in the dialog.
- AG Grid Community only (no Enterprise modules), version pinned to 36.2.0.
