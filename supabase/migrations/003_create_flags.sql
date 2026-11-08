-- 003: flags
-- One row per check that fired for a bill, with a plain-English reason.

CREATE TABLE IF NOT EXISTS flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  check_name  TEXT NOT NULL CHECK (check_name IN (
                'duplicate', 'overcharge', 'new_payee', 'policy_limit'
              )),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flags_bill_id ON flags (bill_id);
