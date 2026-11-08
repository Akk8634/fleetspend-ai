-- 007: point demo vendors at real PayPal SANDBOX personal accounts so that
-- Payouts in the demo land in accounts that exist (sandbox only, no real money).
--
--   sb-ar7jz53774080@personal.example.com -> Apex Fuel Co, Driver Direct Ltd
--   sb-61zd753774053@personal.example.com -> Metro Auto Repair, City Lube Station
--   sb-e47hn753774321@personal.example.com -> ProParts Supply (and Highway Diesel Inc, printed on new-payee.jpg)

-- 1) Existing rows
UPDATE vendors SET paypal_email = 'sb-ar7jz53774080@personal.example.com' WHERE normalized_name IN ('apex fuel', 'driver direct');
UPDATE vendors SET paypal_email = 'sb-61zd753774053@personal.example.com' WHERE normalized_name IN ('metro auto repair', 'city lube station');
UPDATE vendors SET paypal_email = 'sb-e47hn753774321@personal.example.com' WHERE normalized_name IN ('proparts supply', 'highway diesel');

-- Bills still carrying the old placeholder emails follow their vendor.
UPDATE bills b
SET payee_email = v.paypal_email
FROM vendors v
WHERE b.vendor_id = v.id
  AND (b.payee_email IS NULL OR b.payee_email NOT LIKE 'sb-%@personal.example.com');

-- 2) Seed function (single source of seed data) with the sandbox emails
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
    ('Apex Fuel Co',      'apex fuel',         'sb-ar7jz53774080@personal.example.com', 'fuel'),
    ('Metro Auto Repair', 'metro auto repair', 'sb-61zd753774053@personal.example.com', 'repair'),
    ('ProParts Supply',   'proparts supply',   'sb-e47hn753774321@personal.example.com', 'parts'),
    ('Driver Direct Ltd', 'driver direct',     'sb-ar7jz53774080@personal.example.com', 'driver_trip'),
    ('City Lube Station', 'city lube station', 'sb-61zd753774053@personal.example.com', 'other')
  ON CONFLICT (normalized_name) DO UPDATE SET paypal_email = EXCLUDED.paypal_email;

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

REVOKE ALL ON FUNCTION seed_demo_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION seed_demo_data() TO service_role;
