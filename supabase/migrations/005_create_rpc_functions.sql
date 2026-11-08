-- 005: RPC functions, row level security, permissions, seed data
--
-- Every bill status change and its audit_log row happen inside ONE function
-- call, so they commit or roll back together (Requirement 11.5, 11.6).
-- All functions are callable only by the server (service_role).

------------------------------------------------------------------------------
-- create_bill: insert an uploaded bill + its audit row
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_bill(
  p_storage_path      TEXT,
  p_original_filename TEXT
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bill_id UUID;
BEGIN
  INSERT INTO bills (storage_path, original_filename, status)
  VALUES (p_storage_path, p_original_filename, 'uploaded')
  RETURNING id INTO v_bill_id;

  INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor)
  VALUES (v_bill_id, 'status_transition', NULL, 'uploaded', 'system');

  RETURN v_bill_id;
END;
$$;

------------------------------------------------------------------------------
-- transition_bill_status: generic, state-machine-checked status change
-- (used by the payments spec for ready/flagged -> paid)
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION transition_bill_status(
  p_bill_id    UUID,
  p_new_status TEXT,
  p_metadata   JSONB DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prev_status TEXT;
BEGIN
  SELECT status INTO v_prev_status FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found', p_bill_id;
  END IF;

  IF NOT (
    (v_prev_status = 'uploaded'     AND p_new_status IN ('extracted', 'needs_review')) OR
    (v_prev_status = 'extracted'    AND p_new_status IN ('ready', 'flagged'))          OR
    (v_prev_status = 'needs_review' AND p_new_status IN ('ready', 'flagged'))          OR
    (v_prev_status = 'ready'        AND p_new_status = 'paid')                         OR
    (v_prev_status = 'flagged'      AND p_new_status = 'paid')
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> %', v_prev_status, p_new_status;
  END IF;

  UPDATE bills SET status = p_new_status WHERE id = p_bill_id;

  INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
  VALUES (p_bill_id, 'status_transition', v_prev_status, p_new_status, 'system',
          COALESCE(p_metadata, '{}'::jsonb));
END;
$$;

------------------------------------------------------------------------------
-- save_extraction: store AI-extracted fields and move uploaded ->
-- extracted | needs_review. Used for every needs_review path (timeout,
-- service error, zod failure, non-USD, low confidence). On failures with
-- nothing extracted, p_fields is '{}' and p_vendor_id is NULL.
--
-- p_fields keys: vendor_name, amount_text, amount_minor_units, currency_code,
-- bill_date (YYYY-MM-DD), invoice_number, payee_email, category, confidence.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_extraction(
  p_bill_id               UUID,
  p_fields                JSONB,
  p_vendor_id             UUID,
  p_new_status            TEXT,
  p_low_confidence_fields TEXT[],
  p_message               TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prev_status TEXT;
  v_fields      JSONB := COALESCE(p_fields, '{}'::jsonb);
BEGIN
  SELECT status INTO v_prev_status FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found', p_bill_id;
  END IF;

  IF v_prev_status <> 'uploaded' THEN
    RAISE EXCEPTION 'save_extraction requires status=uploaded, got %', v_prev_status;
  END IF;
  IF p_new_status NOT IN ('extracted', 'needs_review') THEN
    RAISE EXCEPTION 'save_extraction: invalid target status %', p_new_status;
  END IF;

  UPDATE bills SET
    vendor_id             = p_vendor_id,
    vendor_name_raw       = v_fields->>'vendor_name',
    amount_text           = v_fields->>'amount_text',
    amount_minor_units    = NULLIF(v_fields->>'amount_minor_units', '')::INTEGER,
    currency_code         = v_fields->>'currency_code',
    bill_date             = NULLIF(v_fields->>'bill_date', '')::DATE,
    invoice_number        = v_fields->>'invoice_number',
    payee_email           = v_fields->>'payee_email',
    category              = v_fields->>'category',
    confidence            = v_fields->'confidence',
    low_confidence_fields = p_low_confidence_fields,
    review_message        = p_message,
    status                = p_new_status
  WHERE id = p_bill_id;

  INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
  VALUES (
    p_bill_id, 'status_transition', v_prev_status, p_new_status, 'system',
    jsonb_build_object(
      'message', p_message,
      'low_confidence_fields', COALESCE(to_jsonb(p_low_confidence_fields), '[]'::jsonb)
    )
  );
END;
$$;

------------------------------------------------------------------------------
-- complete_checks: replace a bill's flags and move it to ready | flagged
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_checks(
  p_bill_id UUID,
  p_flags   JSONB
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prev_status TEXT;
  v_new_status  TEXT;
  v_flag        JSONB;
  v_flag_names  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_flags IS NULL OR jsonb_typeof(p_flags) <> 'array' THEN
    RAISE EXCEPTION 'complete_checks: p_flags must be a JSON array';
  END IF;

  SELECT status INTO v_prev_status FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found', p_bill_id;
  END IF;

  IF v_prev_status NOT IN ('extracted', 'needs_review') THEN
    RAISE EXCEPTION 'complete_checks requires status extracted or needs_review, got %', v_prev_status;
  END IF;

  DELETE FROM flags WHERE bill_id = p_bill_id;

  FOR v_flag IN SELECT * FROM jsonb_array_elements(p_flags)
  LOOP
    INSERT INTO flags (bill_id, check_name, reason)
    VALUES (p_bill_id, v_flag->>'check_name', v_flag->>'reason');
    v_flag_names := array_append(v_flag_names, v_flag->>'check_name');
  END LOOP;

  v_new_status := CASE WHEN jsonb_array_length(p_flags) = 0 THEN 'ready' ELSE 'flagged' END;

  UPDATE bills
  SET status = v_new_status,
      review_message = NULL
  WHERE id = p_bill_id;

  INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
  VALUES (
    p_bill_id, 'status_transition', v_prev_status, v_new_status, 'system',
    jsonb_build_object('flags', to_jsonb(v_flag_names))
  );
END;
$$;

------------------------------------------------------------------------------
-- save_field_corrections: owner fixes a needs_review bill.
-- p_corrections keys are bills column names (the API route maps form fields):
--   vendor_name_raw, vendor_id, amount_text, amount_minor_units,
--   currency_code, bill_date, invoice_number, payee_email
-- The audit row records every changed field with its prior and new value.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_field_corrections(
  p_bill_id     UUID,
  p_corrections JSONB,
  p_actor       TEXT DEFAULT 'demo_owner'
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed CONSTANT TEXT[] := ARRAY[
    'vendor_name_raw', 'vendor_id', 'amount_text', 'amount_minor_units',
    'currency_code', 'bill_date', 'invoice_number', 'payee_email'
  ];
  v_status  TEXT;
  v_before  JSONB;
  v_after   JSONB;
  v_key     TEXT;
  v_changes JSONB := '{}'::jsonb;
BEGIN
  IF p_corrections IS NULL OR jsonb_typeof(p_corrections) <> 'object' THEN
    RAISE EXCEPTION 'save_field_corrections: p_corrections must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_corrections)
  LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'save_field_corrections: field % cannot be corrected', v_key;
    END IF;
  END LOOP;

  SELECT status, to_jsonb(b) INTO v_status, v_before
  FROM bills b WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found', p_bill_id;
  END IF;

  IF v_status <> 'needs_review' THEN
    RAISE EXCEPTION 'save_field_corrections requires status=needs_review, got %', v_status;
  END IF;

  UPDATE bills SET
    vendor_name_raw    = COALESCE(p_corrections->>'vendor_name_raw',                 vendor_name_raw),
    vendor_id          = COALESCE(NULLIF(p_corrections->>'vendor_id', '')::UUID,     vendor_id),
    amount_text        = COALESCE(p_corrections->>'amount_text',                     amount_text),
    amount_minor_units = COALESCE(NULLIF(p_corrections->>'amount_minor_units', '')::INTEGER, amount_minor_units),
    currency_code      = COALESCE(p_corrections->>'currency_code',                   currency_code),
    bill_date          = COALESCE(NULLIF(p_corrections->>'bill_date', '')::DATE,     bill_date),
    invoice_number     = COALESCE(p_corrections->>'invoice_number',                  invoice_number),
    payee_email        = COALESCE(p_corrections->>'payee_email',                     payee_email)
  WHERE id = p_bill_id;

  SELECT to_jsonb(b) INTO v_after FROM bills b WHERE id = p_bill_id;

  FOR v_key IN SELECT jsonb_object_keys(p_corrections)
  LOOP
    IF (v_before->v_key) IS DISTINCT FROM (v_after->v_key) THEN
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('old', v_before->v_key, 'new', v_after->v_key)
      );
    END IF;
  END LOOP;

  INSERT INTO audit_log (bill_id, event, actor, metadata)
  VALUES (
    p_bill_id, 'field_corrected', COALESCE(p_actor, 'demo_owner'),
    jsonb_build_object(
      'fields', (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(v_changes) AS k),
      'changes', v_changes
    )
  );
END;
$$;

------------------------------------------------------------------------------
-- get_overcharge_history: count and sum of PAID bills for a vendor+currency.
-- An RPC because Supabase's REST API has aggregate functions disabled by default.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_overcharge_history(
  p_vendor_id     UUID,
  p_currency_code TEXT
) RETURNS TABLE (paid_count BIGINT, paid_sum BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COUNT(*)::BIGINT, COALESCE(SUM(amount_minor_units), 0)::BIGINT
  FROM bills
  WHERE vendor_id = p_vendor_id
    AND currency_code = p_currency_code
    AND status = 'paid';
$$;

------------------------------------------------------------------------------
-- seed_demo_data: the ONLY place seed data lives (seed.sql and reset_demo call it).
-- 5 vendors, 15 paid bills (3 per vendor), dated 2025-11 .. 2026-10, all USD.
-- Safe to call twice: it does nothing if seed bills already exist.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_demo_data()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bills WHERE is_seed) THEN
    RETURN;
  END IF;

  INSERT INTO vendors (name, normalized_name, paypal_email, category) VALUES
    ('Apex Fuel Co',      'apex fuel',         'apex-fuel@example.com',     'fuel'),
    ('Metro Auto Repair', 'metro auto repair', 'metro-repair@example.com',  'repair'),
    ('ProParts Supply',   'proparts supply',   'proparts@example.com',      'parts'),
    ('Driver Direct Ltd', 'driver direct',     'driver-direct@example.com', 'driver_trip'),
    ('City Lube Station', 'city lube station', 'city-lube@example.com',     'other')
  ON CONFLICT (normalized_name) DO NOTHING;

  WITH seed (normalized_name, invoice_number, amount_minor_units, bill_date) AS (
    VALUES
      ('apex fuel',         'APX-001', 22000, DATE '2025-11-10'),
      ('apex fuel',         'APX-002', 18000, DATE '2026-02-05'),
      ('apex fuel',         'APX-003', 20000, DATE '2026-06-15'),
      ('metro auto repair', 'MAR-001', 85000, DATE '2025-11-20'),
      ('metro auto repair', 'MAR-002', 92000, DATE '2026-03-30'),
      ('metro auto repair', 'MAR-003', 78000, DATE '2026-08-01'),
      ('proparts supply',   'PPS-001', 34000, DATE '2025-12-12'),
      ('proparts supply',   'PPS-002', 31000, DATE '2026-04-18'),
      ('proparts supply',   'PPS-003', 36000, DATE '2026-09-22'),
      ('driver direct',     'DDL-001', 15000, DATE '2025-11-05'),
      ('driver direct',     'DDL-002', 17500, DATE '2026-01-10'),
      ('driver direct',     'DDL-003', 16000, DATE '2026-07-08'),
      ('city lube station', 'CLS-001',  9500, DATE '2025-12-25'),
      ('city lube station', 'CLS-002', 10500, DATE '2026-05-30'),
      ('city lube station', 'CLS-003',  8800, DATE '2026-10-01')
  ),
  inserted AS (
    INSERT INTO bills (
      vendor_id, storage_path, original_filename, status,
      vendor_name_raw, amount_text, amount_minor_units, currency_code,
      bill_date, invoice_number, payee_email, category, is_seed
    )
    SELECT
      v.id,
      'seed/' || s.invoice_number,
      s.invoice_number || '.pdf',
      'paid',
      v.name,
      to_char(s.amount_minor_units / 100.0, 'FM999999990.00'),
      s.amount_minor_units,
      'USD',
      s.bill_date,
      s.invoice_number,
      v.paypal_email,
      v.category,
      true
    FROM seed s
    JOIN vendors v ON v.normalized_name = s.normalized_name
    RETURNING id
  )
  INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
  SELECT id, 'seeded', NULL, 'paid', 'seed', '{"source": "seed_demo_data"}'::jsonb
  FROM inserted;
END;
$$;

------------------------------------------------------------------------------
-- reset_demo: wipe all demo data and re-seed. The API route checks
-- DEMO_MODE=true and empties the Storage bucket before calling this.
-- TRUNCATE is the only way audit_log is ever cleared.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_demo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE audit_log, flags, bills, vendors RESTART IDENTITY CASCADE;
  PERFORM seed_demo_data();
END;
$$;

------------------------------------------------------------------------------
-- Row level security: on, with no policies. Only service_role (server) can
-- read or write. The browser never talks to the database directly.
------------------------------------------------------------------------------
ALTER TABLE vendors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills     ENABLE ROW LEVEL SECURITY;
ALTER TABLE flags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON vendors, bills, flags, audit_log FROM anon, authenticated;

------------------------------------------------------------------------------
-- Function permissions: server only.
------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION create_bill(TEXT, TEXT)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION transition_bill_status(UUID, TEXT, JSONB)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION save_extraction(UUID, JSONB, UUID, TEXT, TEXT[], TEXT)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION complete_checks(UUID, JSONB)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION save_field_corrections(UUID, JSONB, TEXT)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION get_overcharge_history(UUID, TEXT)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION seed_demo_data()                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reset_demo()                                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION set_updated_at()                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION audit_log_immutable()                                   FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION create_bill(TEXT, TEXT)                                TO service_role;
GRANT EXECUTE ON FUNCTION transition_bill_status(UUID, TEXT, JSONB)              TO service_role;
GRANT EXECUTE ON FUNCTION save_extraction(UUID, JSONB, UUID, TEXT, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION complete_checks(UUID, JSONB)                           TO service_role;
GRANT EXECUTE ON FUNCTION save_field_corrections(UUID, JSONB, TEXT)              TO service_role;
GRANT EXECUTE ON FUNCTION get_overcharge_history(UUID, TEXT)                     TO service_role;
GRANT EXECUTE ON FUNCTION seed_demo_data()                                       TO service_role;
GRANT EXECUTE ON FUNCTION reset_demo()                                           TO service_role;
