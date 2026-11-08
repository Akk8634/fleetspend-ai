-- 001: vendors
-- A payee (fuel station, mechanic, parts shop, driver agency...).
-- Bills are matched to vendors by normalized_name (see lib/vendors/normalizeVendorName.ts).

CREATE TABLE IF NOT EXISTS vendors (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  normalized_name  TEXT NOT NULL UNIQUE,
  paypal_email     TEXT,
  category         TEXT CHECK (category IS NULL OR category IN ('fuel', 'repair', 'parts', 'driver_trip', 'other')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- normalized_name already has a unique index from the UNIQUE constraint,
-- which serves every lookup by normalized name.
