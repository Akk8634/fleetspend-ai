# Security and payment safety

- No payout can be created unless the bill's status is "approved" and the approval was made by a human action in the UI.
- Every payout batch uses a unique sender_batch_id derived from the approved bill IDs, so a retry can never pay twice.
- A bill already marked "paid" or "payout_pending" can never be included in a new batch.
- Payout status is confirmed from PayPal's API on the server, never trusted from the client.
- Every state change (uploaded, extracted, flagged, approved, paid, failed) writes an audit_log row. Audit rows are never updated or deleted by the app.
- Validate and size-limit every upload (images/PDF only, max 10 MB).
- Never log secrets, tokens or full API responses containing them.