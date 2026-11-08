# Product: FleetSpend AI

AI accounts-payable agent for small fleet/transport businesses (5–50 vehicles).

## Users
- Owner/manager who pays drivers, mechanics, fuel stations and parts vendors every week.
- Not an accountant. Needs plain-English explanations, not jargon.

## Core flow
1. Upload bills (photo/PDF) → AI extracts vendor, amount, currency, date, invoice number, category.
2. AI checks each bill: duplicate, overcharge vs vendor history, first-time payee, policy limit.
3. Approval table shows every bill with flags and a one-line reason.
4. Human approves a batch → PayPal Payouts (sandbox) pays every payee → status tracked → audit log.

## Non-negotiable principles
- The AI never moves money on its own. Every payout requires explicit human approval.
- Every AI flag must have a human-readable reason.
- A bill can never be paid twice (idempotency at every layer).
- Demo must work with zero setup: seeded demo data, no login.

## Out of scope (for now)
Login/roles, multi-company, mobile app, real (non-sandbox) payments, reports/analytics.

## Hackathons
Built for the PayPal AI Hackathon and Kiroween 2026 (Frankenstein category).
PayPal integration and AI must be central and genuine, never mocked.