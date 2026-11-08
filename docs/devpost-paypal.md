# Devpost submission — PayPal AI Hackathon

Copy each section into the matching Devpost field.

---

## Project name
FleetSpend AI

## Tagline (short description)
An AI accounts-payable agent for small fleet businesses: it reads every bill, catches duplicates and overcharges, and pays drivers and vendors with PayPal Payouts — only after a human approves.

## Links
- Live demo (PayPal sandbox): https://fleetspend-ai.vercel.app
- Code (MIT): https://github.com/Akk8634/fleetspend-ai
- Demo video: https://youtu.be/NouA0U1xPnU

---

## Inspiration
Small transport businesses pay dozens of small bills every week — fuel, repairs, parts, relief drivers. The bills arrive as phone photos, the owner types them in by hand, and nobody notices when the same invoice is paid twice, a mechanic suddenly charges three times the usual price, or a brand-new "vendor" asks to be paid. We wanted an AI that does the boring reading and checking, and a payment rail that can pay everyone at once — without ever letting the AI move money on its own.

## What it does
1. **Reads bills with AI.** Upload photos or PDFs; Gemini extracts vendor, amount (exactly as printed), currency, date, invoice number, payee PayPal email and category, with a confidence score per field.
2. **Checks every bill** and explains each flag in plain English: duplicate invoice, overcharge (> 2× the vendor's average), first-time payee, and per-bill spending limit.
3. **Asks a human when unsure.** Low-confidence bills open a review screen with the original photo next to the form and the unsure fields highlighted.
4. **Pays with PayPal Payouts.** In an AG Grid approval table the owner selects bills, sees every payee and the total, types a reason for any flagged bill, and pays everyone in one PayPal Payouts batch. Bills become "Paid" only when PayPal reports SUCCESS for their item.
5. **Payment Assistant (agentic commerce).** "Pay all clean fuel bills from this week" → the agent builds a payment plan, explains why each bill is in or out, and hands it to the same human approval step.

## How we built it
- **PayPal developer platform:** OAuth2 client credentials with token caching; **Payouts API** create (`POST /v1/payments/payouts`) with one item per approved bill and `sender_item_id` = our item id; status sync (`GET /v1/payments/payouts/{id}`) mapping SUCCESS / PENDING / UNCLAIMED / FAILED / RETURNED and more; **idempotency** with `sender_batch_id` and `PayPal-Request-Id` so a retried request can never pay twice; 4xx answers mark the batch rejected with PayPal's own message, timeouts / 5xx keep it safe for a resend.
- **AI:** Google Gemini (`gemini-3.5-flash-lite`) in JSON mode with a response schema, validated again with zod — for bill extraction (vision) and for turning the owner's instruction into **selection criteria only**. A deterministic plan engine applies the criteria, guardrails and a $5,000 cap; bill ids the AI might return are stripped.
- **App:** Next.js 16 + React 19 + TypeScript, Tailwind, AG Grid Community for the approval table, Supabase Postgres + Storage with row-level security, deployed on Vercel.
- **Safety in the database:** every status change and its audit row are one transaction; a partial unique index allows only one live payout per bill; a trigger lets payout outcomes only move forward; approving a flagged bill without a reason is rejected by the database itself.
- **Testing:** 205 automated tests including 13 property-based properties (fast-check) for money conversion, the checks, PayPal request building, status mapping and plan safety; plus opt-in live tests that really call Gemini, Supabase and the PayPal sandbox.
- **Process:** spec-first — requirements, design and task lists for each feature before code (Kiro spec format), implemented task by task.

## Challenges we ran into
- **PayPal country rules:** our first sandbox business account was created in a country that cannot send Payouts (`PAYOUT_NOT_AVAILABLE`). The app handled it correctly (batch rejected, bills marked "Payment failed", retry allowed); a US sandbox business account fixed it.
- **Unknown outcomes:** if PayPal times out, did the money move? We never guess: the batch stays "submitting" and is resent with the same request id, which PayPal treats as the same payout.
- **Batch status lag:** PayPal's batch status can still say PROCESSING after every item succeeded, so we derive "Completed" from the items.
- **Model availability:** the newest Gemini Flash models returned 503 "high demand" or exceeded our 20 s timeout during testing; we benchmarked models and chose one that reads every sample bill correctly in 1.5–3.5 s.

## Accomplishments that we're proud of
- Real end-to-end payouts in the PayPal sandbox — including a flagged bill approved with a written reason and a plan suggested by the AI agent — with transaction ids shown in the app.
- An agent that is genuinely useful but provably bounded: it can't pick bills, can't exceed limits, can't include flagged bills unless asked, and can't pay.
- "Never pay twice" enforced in three independent layers.

## What we learned
Agentic payments are safest when the AI's job is narrowed to understanding intent, while selection, limits and money movement stay in deterministic, testable code with a human approval in front of PayPal.

## What's next for FleetSpend AI
- PayPal webhooks instead of polling; multi-user approval roles (e.g. two approvals above a threshold).
- More currencies and an India version using local payout rails.
- Learning normal prices per vendor and route to catch subtler overcharges.

## Built with
nextjs, react, typescript, tailwindcss, paypal-payouts-api, paypal-rest-api, google-gemini, supabase, postgresql, ag-grid, zod, vitest, fast-check, vercel

## Tools used (AI tools and how they were used)
- **Google Gemini (`gemini-3.5-flash-lite`)** — runtime AI inside the product: bill extraction from images/PDFs with per-field confidence, and converting the owner's payment instructions into structured selection criteria.
- **Kiro** — wrote the steering docs and the first feature spec (requirements → design → tasks).
- **Claude Code** — implemented the specs task by task and wrote the tests (after the Kiro free credits ran out).
- **PayPal Developer sandbox** — Payouts, OAuth, sandbox business and personal accounts.

## Testing instructions for judges
1. Open https://fleetspend-ai.vercel.app (no login; PayPal sandbox only).
2. Click **Reset demo**, then **Try the 8 sample bills** and wait ~1 minute.
3. Click **Review** on the blurry receipt, fix the amount/date, save.
4. In **Payment Assistant**, click "Pay all Apex Fuel bills, including flagged ones" → **Review & approve** → type a reason → **Pay with PayPal**.
5. Watch the bills turn **Paid** with PayPal transaction ids; see the batch in **Payments**.
To run it yourself, follow the README (Supabase + Gemini key + PayPal sandbox app with Payouts).
