# Manual test checklist — invoice processing

End-to-end demo check for the 8 sample bills. Run it before recording a demo video or after deploying.

## Pre-conditions

- [ ] Migrations `supabase/migrations/001`–`006` and `supabase/seed.sql` have been run on the Supabase project.
- [ ] `.env.local` (or the hosting env) has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.5-flash-lite`, `POLICY_LIMIT_MINOR_UNITS=100000`, `DEMO_MODE=true`.
- [ ] The 8 images are in `public/samples/` (regenerate with `python scripts/generate-sample-bills.py`).
- [ ] App is running (`npm run dev`, or the deployed URL).

## 1. Start clean

- [ ] Click **Reset demo** in the header and confirm the dialog.
- [ ] The page shows "No bills yet", and the summary cards show $0.00 / 0 / 0.

## 2. Upload and process the samples

Click **Try the 8 sample bills** (or drag the 8 files from `public/samples/` in this order). Each row goes Queued → Uploading → "AI is reading the bill…" → a final badge, one bill at a time.

| # | File | Expected status | Expected flag and reason |
|---|------|-----------------|--------------------------|
| 1 | `ready-1.jpg` | Ready to pay | none — ProParts Supply, $320.00, #PPS-104, Nov 2, 2026 |
| 2 | `ready-2.jpg` | Ready to pay | none — Driver Direct Ltd, $160.00, #DDL-104 |
| 3 | `ready-3.jpg` | Ready to pay | none — printed "City Lube Stn." is listed as **City Lube Station**, $90.00 |
| 4 | `ready-4.jpg` | Ready to pay | none — printed "Apex Fuel Company" is listed as **Apex Fuel Co**, $210.00 |
| 5 | `duplicate.jpg` | Flagged | **Duplicate** — "Possible duplicate of invoice MAR-002 from Metro Auto Repair on 2026-03-30." |
| 6 | `overcharge.jpg` | Flagged | **Overcharge** — "Amount of $450.00 is more than 2x the usual $200.00 average for Apex Fuel Co." |
| 7 | `new-payee.jpg` | Flagged | **New payee** — "First-time payee: Highway Diesel Inc has no payment history." |
| 8 | `needs-review.jpg` | Needs review | "The AI was not sure about: …" (amount and/or date) |

- [ ] Summary cards: Ready to pay **$780.00** (4 bills), Flagged **3** ($1,445.00), Needs review **1**.
- [ ] No bill shows a "policy limit" flag (all amounts are ≤ $1,000.00).

## 3. Review the unsure bill

- [ ] Click **Review** on the Metro Auto Repair row. The bill photo is on the left, the form on the right.
- [ ] The amount and date fields are highlighted amber with an "AI unsure" tag; the yellow box explains why.
- [ ] Enter amount `12.345` and save → the amount field shows an error and nothing is saved.
- [ ] Enter amount `378.50`, date `2026-11-07`, save → you return to the list.
- [ ] The bill is now **Ready to pay**, $378.50, and the summary shows Ready to pay **$1,158.50** (5 bills), Needs review **0**.

## 4. Approve and pay with PayPal (sandbox)

Pre-condition: `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` belong to a sandbox app whose business account is in a country that can send Payouts (e.g. **United States**) and has the **Payouts** feature enabled.

- [ ] Click **Select all ready (5)** → the action bar shows "5 selected · $1,158.50".
- [ ] Also tick the **Apex Fuel Co #APX-105** (overcharge) bill → the bar notes "(includes flagged bills)".
- [ ] Click **Approve & pay** → the dialog lists every payee email, amount and the total ($1,608.50); the flagged bill shows its Overcharge reason and an empty reason box; the Pay button is disabled.
- [ ] Type a reason (e.g. "Called Apex: fuel price went up this week") → click **Pay $1,608.50 with PayPal**.
- [ ] A green notice says how much was sent; bills show **Paying…** or **Paid** with a PayPal transaction id; the **Payments** section shows the batch with its PayPal batch id.
- [ ] Within about a minute all 6 bills are **Paid** (the page checks PayPal every 5 s) and the **Paid** card shows $1,608.50.
- [ ] In the PayPal Developer dashboard, the sandbox personal accounts' balances went up by the paid amounts.
- [ ] Select a **Paid** bill → impossible (no checkbox). Calling `POST /api/payouts` with a paid bill id returns 409 "Bill is paid and cannot be approved."
- [ ] Leave the duplicate (MAR-002) and new-payee bills unpaid: flagged bills are never paid without a typed reason.

## 5. Edge cases (optional)

- [ ] Upload a `.gif` or a `.txt` file → the row shows "Use a JPG, PNG or PDF file." and other files still process.
- [ ] Upload `overcharge.jpg` a second time → it is flagged **Duplicate** (and Overcharge) because APX-105 already exists.
- [ ] Call `POST /api/bills/<id>/process` again for a finished bill → returns `"skipped": true` without calling Gemini.

## 6. Reset

- [ ] Click **Reset demo** → confirm → the list and the Payments section are empty again and the seed vendor history is restored (repeat step 2 and get the same results).

## Known limits

- Vercel serverless functions accept request bodies up to about 4.5 MB. Bills are uploaded one file per request; files over ~4.5 MB may fail on Vercel even though the app allows 10 MB (fine locally).
- PayPal Payouts cannot be sent from sandbox business accounts in some countries (PayPal answers `PAYOUT_NOT_AVAILABLE`, "You live in a country that is not allowed to send this payout"). Use a US sandbox business account for the app. The app handles this safely: the batch is marked Rejected and the bills become "Payment failed" and can be retried.
- Gemini timing: typically 1.5–3.5 s per bill with `gemini-3.5-flash-lite`; total per bill about 4–7 s including storage and database. A slow first attempt is retried once after 5 s.
