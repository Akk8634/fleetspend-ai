# Project structure

- app/                → Next.js routes and pages (UI + API route handlers under app/api/)
- components/         → React UI components
- lib/ai/             → Gemini client, extraction prompts, response schemas
- lib/checks/         → duplicate, overcharge, new-payee and policy-limit checks (pure functions, fully tested)
- lib/paypal/         → PayPal auth, payouts, status sync
- lib/db/             → Supabase client and data-access functions
- supabase/migrations/→ SQL migrations
- supabase/seed.sql   → demo vendors, past bills and sample data
- public/samples/     → sample bill images for the demo
- tests/              → Vitest + fast-check tests
- docs/               → architecture notes and Kiro usage write-up

Business logic lives in lib/, never inside React components or route handlers.