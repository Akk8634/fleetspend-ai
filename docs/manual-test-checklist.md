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

## 4. Edge cases (optional)

- [ ] Upload a `.gif` or a `.txt` file → the row shows "Use a JPG, PNG or PDF file." and other files still process.
- [ ] Upload `overcharge.jpg` a second time → it is flagged **Duplicate** (and Overcharge) because APX-105 already exists.
- [ ] Call `POST /api/bills/<id>/process` again for a finished bill → returns `"skipped": true` without calling Gemini.

## 5. Reset

- [ ] Click **Reset demo** → confirm → the list is empty again and the seed vendor history is restored (repeat step 2 and get the same results).

## Known limits

- Vercel serverless functions accept request bodies up to about 4.5 MB. Bills are uploaded one file per request; files over ~4.5 MB may fail on Vercel even though the app allows 10 MB (fine locally).
- Gemini timing: typically 1.5–3.5 s per bill with `gemini-3.5-flash-lite`; total per bill about 4–7 s including storage and database. A slow first attempt is retried once after 5 s.
