-- 002: bills
-- One uploaded invoice and its lifecycle.
-- Money is stored only as integer minor units (cents). Never floats.

CREATE TABLE IF NOT EXISTS bills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             UUID REFERENCES vendors(id),
  storage_path          TEXT NOT NULL,
  original_filename     TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'uploaded', 'extracted', 'needs_review',
                          'ready', 'flagged', 'paid'
                        )),
  vendor_name_raw       TEXT,
  amount_text           TEXT,
  amount_minor_units    INTEGER CHECK (amount_minor_units IS NULL OR amount_minor_units BETWEEN 1 AND 999999999),
  currency_code         TEXT CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  bill_date             DATE,
  invoice_number        TEXT,
  payee_email           TEXT,
  category              TEXT,
  confidence            JSONB,
  low_confidence_fields TEXT[],
  review_message        TEXT,
  is_seed               BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bills_vendor_id     ON bills (vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status        ON bills (status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor_status ON bills (vendor_id, status);

-- Keep updated_at current on every row update.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_updated_at ON bills;
CREATE TRIGGER trg_bills_updated_at
BEFORE UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
