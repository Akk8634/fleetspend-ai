-- 004: audit_log (append-only)
-- Every bill status change and every manual correction writes one row here.
-- Rows can never be updated or deleted. The only way to clear the table is
-- TRUNCATE inside reset_demo() (demo mode only), because TRUNCATE does not
-- fire row-level triggers.

CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      UUID REFERENCES bills(id),
  event        TEXT NOT NULL CHECK (event IN ('status_transition', 'field_corrected', 'seeded')),
  prev_status  TEXT,
  new_status   TEXT,
  actor        TEXT NOT NULL DEFAULT 'system',
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_bill_id ON audit_log (bill_id);

CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable: UPDATE and DELETE are not permitted';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
