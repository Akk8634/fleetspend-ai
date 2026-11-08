-- 008: payment workflow (spec: .kiro/specs/payment-workflow)
-- Human-approved PayPal Payouts (sandbox). A bill becomes 'paid' only when
-- PayPal reports SUCCESS for its payout item. A bill can never have two live
-- payout items (partial unique index), and item outcomes only move forward.

------------------------------------------------------------------------------
-- Bill states and audit events
------------------------------------------------------------------------------
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_status_check CHECK (status IN (
  'uploaded', 'extracted', 'needs_review', 'ready', 'flagged',
  'payout_pending', 'paid', 'payout_failed'
));

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_event_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_check CHECK (event IN (
  'status_transition', 'field_corrected', 'seeded',
  'approved', 'payout_status', 'payout_rejected'
));

-- Generic transitions no longer include any path to 'paid'; payment RPCs own those.
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
    (v_prev_status = 'needs_review' AND p_new_status IN ('ready', 'flagged'))
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
-- Tables
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- = PayPal sender_batch_id
  paypal_batch_id    TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'submitting',
  item_count         INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 50),
  total_minor_units  BIGINT NOT NULL CHECK (total_minor_units > 0),
  currency_code      TEXT NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
  approved_by        TEXT NOT NULL,
  error_name         TEXT,
  error_message      TEXT,
  finished           BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- = PayPal sender_item_id
  batch_id            UUID NOT NULL REFERENCES payout_batches(id),
  bill_id             UUID NOT NULL REFERENCES bills(id),
  receiver_email      TEXT NOT NULL,
  amount_minor_units  INTEGER NOT NULL CHECK (amount_minor_units BETWEEN 1 AND 999999999),
  currency_code       TEXT NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
  note                TEXT NOT NULL,
  override_reason     TEXT CHECK (override_reason IS NULL OR char_length(override_reason) <= 500),
  outcome             TEXT NOT NULL DEFAULT 'queued' CHECK (outcome IN ('queued', 'pending', 'success', 'failed')),
  paypal_item_id      TEXT,
  transaction_id      TEXT,
  transaction_status  TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_items_batch ON payout_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_bill  ON payout_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_payout_batches_created ON payout_batches (created_at DESC);

-- Requirement 4.1: at most one live payout item per bill.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_items_live_bill
  ON payout_items (bill_id)
  WHERE outcome IN ('queued', 'pending', 'success');

DROP TRIGGER IF EXISTS trg_payout_batches_updated_at ON payout_batches;
CREATE TRIGGER trg_payout_batches_updated_at BEFORE UPDATE ON payout_batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Requirement 6.3: items are never deleted; outcome only moves forward; money fields are frozen.
CREATE OR REPLACE FUNCTION payout_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout_items rows cannot be deleted';
  END IF;

  IF NEW.batch_id <> OLD.batch_id OR NEW.bill_id <> OLD.bill_id
     OR NEW.receiver_email <> OLD.receiver_email OR NEW.amount_minor_units <> OLD.amount_minor_units
     OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'payout_items payment details cannot be changed';
  END IF;

  IF NEW.outcome <> OLD.outcome AND NOT (
    (OLD.outcome = 'queued'  AND NEW.outcome IN ('pending', 'success', 'failed')) OR
    (OLD.outcome = 'pending' AND NEW.outcome IN ('success', 'failed'))
  ) THEN
    RAISE EXCEPTION 'payout item outcome cannot move from % to %', OLD.outcome, NEW.outcome;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payout_items_guard ON payout_items;
CREATE TRIGGER trg_payout_items_guard BEFORE UPDATE OR DELETE ON payout_items
FOR EACH ROW EXECUTE FUNCTION payout_items_guard();

------------------------------------------------------------------------------
-- approve_and_create_batch: the ONLY way a payout is created (human approval).
-- Validates every bill; on any problem raises APPROVAL_REJECTED with a JSON
-- array of {bill_id, label, reason} in DETAIL and writes nothing.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_and_create_batch(
  p_bill_ids  UUID[],
  p_overrides JSONB,
  p_actor     TEXT
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_overrides JSONB := COALESCE(p_overrides, '{}'::jsonb);
  v_problems  JSONB := '[]'::jsonb;
  v_batch_id  UUID;
  v_total     BIGINT := 0;
  v_reason    TEXT;
  v_label     TEXT;
  r           RECORD;
  v_id        UUID;
BEGIN
  IF p_bill_ids IS NULL OR cardinality(p_bill_ids) = 0 THEN
    RAISE EXCEPTION 'APPROVAL_REJECTED' USING DETAIL = '[{"bill_id":null,"label":"Approval","reason":"Select at least one bill."}]';
  END IF;
  IF cardinality(p_bill_ids) > 50 THEN
    RAISE EXCEPTION 'APPROVAL_REJECTED' USING DETAIL = '[{"bill_id":null,"label":"Approval","reason":"At most 50 bills can be paid at once."}]';
  END IF;
  IF cardinality(p_bill_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_bill_ids) AS x) THEN
    RAISE EXCEPTION 'APPROVAL_REJECTED' USING DETAIL = '[{"bill_id":null,"label":"Approval","reason":"The same bill was selected twice."}]';
  END IF;

  -- Lock in a stable order to avoid deadlocks between concurrent approvals.
  PERFORM 1 FROM bills WHERE id = ANY (p_bill_ids) ORDER BY id FOR UPDATE;

  FOREACH v_id IN ARRAY p_bill_ids LOOP
    SELECT b.*, COALESCE(v.name, b.vendor_name_raw, b.original_filename) AS label_name
      INTO r
      FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id
     WHERE b.id = v_id;

    IF NOT FOUND THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', 'Unknown bill', 'reason', 'Bill not found.');
      CONTINUE;
    END IF;

    v_label  := r.label_name || COALESCE(' #' || r.invoice_number, '');
    v_reason := NULLIF(btrim(v_overrides->>v_id::text), '');

    IF r.status NOT IN ('ready', 'flagged', 'payout_failed') THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', format('Bill is %s and cannot be approved.', replace(r.status, '_', ' ')));
    END IF;
    IF r.status = 'flagged' AND v_reason IS NULL THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', 'Flagged bill: type a reason to approve it anyway.');
    END IF;
    IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', 'Override reason is longer than 500 characters.');
    END IF;
    IF r.payee_email IS NULL OR btrim(r.payee_email) = '' THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', 'No PayPal email for this payee.');
    END IF;
    IF r.currency_code IS DISTINCT FROM 'USD' THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', 'Only USD bills can be paid.');
    END IF;
    IF r.amount_minor_units IS NULL THEN
      v_problems := v_problems || jsonb_build_object('bill_id', v_id, 'label', v_label,
        'reason', 'Bill has no amount.');
    ELSE
      v_total := v_total + r.amount_minor_units;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_problems) > 0 THEN
    RAISE EXCEPTION 'APPROVAL_REJECTED' USING DETAIL = v_problems::text;
  END IF;

  INSERT INTO payout_batches (status, item_count, total_minor_units, currency_code, approved_by)
  VALUES ('submitting', cardinality(p_bill_ids), v_total, 'USD', COALESCE(p_actor, 'demo_owner'))
  RETURNING id INTO v_batch_id;

  FOREACH v_id IN ARRAY p_bill_ids LOOP
    SELECT b.*, COALESCE(v.name, b.vendor_name_raw) AS vendor_label,
           (SELECT COALESCE(jsonb_agg(f.check_name), '[]'::jsonb) FROM flags f WHERE f.bill_id = b.id) AS flag_names
      INTO r
      FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id
     WHERE b.id = v_id;

    v_reason := NULLIF(btrim(v_overrides->>v_id::text), '');

    INSERT INTO payout_items (batch_id, bill_id, receiver_email, amount_minor_units, currency_code, note, override_reason)
    VALUES (
      v_batch_id, v_id, btrim(r.payee_email), r.amount_minor_units, 'USD',
      left(COALESCE(r.vendor_label, 'Vendor') || ' · ' ||
           COALESCE('invoice ' || r.invoice_number, 'bill dated ' || r.bill_date::text, 'bill'), 160),
      CASE WHEN r.status = 'flagged' THEN v_reason ELSE NULL END
    );

    UPDATE bills SET status = 'payout_pending' WHERE id = v_id;

    INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
    VALUES (v_id, 'approved', r.status, 'payout_pending', COALESCE(p_actor, 'demo_owner'),
      jsonb_build_object(
        'batch_id', v_batch_id,
        'amount_minor_units', r.amount_minor_units,
        'receiver_email', btrim(r.payee_email),
        'override_reason', CASE WHEN r.status = 'flagged' THEN v_reason ELSE NULL END,
        'overridden_checks', CASE WHEN r.status = 'flagged' THEN r.flag_names ELSE '[]'::jsonb END
      ));
  END LOOP;

  RETURN v_batch_id;
END;
$$;

------------------------------------------------------------------------------
-- mark_batch_submitted: PayPal accepted the batch.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_batch_submitted(
  p_batch_id        UUID,
  p_paypal_batch_id TEXT,
  p_status          TEXT
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_batch payout_batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM payout_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout batch % not found', p_batch_id;
  END IF;

  IF v_batch.paypal_batch_id IS NOT NULL THEN
    IF v_batch.paypal_batch_id = p_paypal_batch_id THEN
      RETURN; -- same PayPal batch reported again (idempotent resend)
    END IF;
    RAISE EXCEPTION 'Payout batch % is already linked to PayPal batch %', p_batch_id, v_batch.paypal_batch_id;
  END IF;
  IF v_batch.status <> 'submitting' THEN
    RAISE EXCEPTION 'Payout batch % is %, not submitting', p_batch_id, v_batch.status;
  END IF;

  UPDATE payout_batches
     SET paypal_batch_id = p_paypal_batch_id, status = lower(COALESCE(p_status, 'pending'))
   WHERE id = p_batch_id;

  UPDATE payout_items SET outcome = 'pending' WHERE batch_id = p_batch_id AND outcome = 'queued';
END;
$$;

------------------------------------------------------------------------------
-- mark_batch_rejected: PayPal refused the whole request (4xx).
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_batch_rejected(
  p_batch_id      UUID,
  p_error_name    TEXT,
  p_error_message TEXT
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_msg    TEXT := left(COALESCE(p_error_message, p_error_name, 'PayPal rejected the payout.'), 500);
  r        RECORD;
BEGIN
  SELECT status INTO v_status FROM payout_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout batch % not found', p_batch_id;
  END IF;
  IF v_status <> 'submitting' THEN
    RAISE EXCEPTION 'Payout batch % is %, not submitting', p_batch_id, v_status;
  END IF;

  UPDATE payout_batches
     SET status = 'failed', finished = true, error_name = p_error_name, error_message = v_msg
   WHERE id = p_batch_id;

  FOR r IN SELECT id, bill_id FROM payout_items WHERE batch_id = p_batch_id AND outcome = 'queued' LOOP
    UPDATE payout_items SET outcome = 'failed', error_message = v_msg WHERE id = r.id;
    UPDATE bills SET status = 'payout_failed' WHERE id = r.bill_id AND status = 'payout_pending';
    INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
    VALUES (r.bill_id, 'payout_rejected', 'payout_pending', 'payout_failed', 'paypal',
            jsonb_build_object('batch_id', p_batch_id, 'error_name', p_error_name, 'error_message', v_msg));
  END LOOP;
END;
$$;

------------------------------------------------------------------------------
-- apply_payout_sync: apply item statuses fetched from PayPal by the server.
-- p_items: [{sender_item_id, paypal_item_id, transaction_id, transaction_status,
--            outcome ('pending'|'success'|'failed'), error_message}]
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_payout_sync(
  p_batch_id     UUID,
  p_batch_status TEXT,
  p_items        JSONB
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_batch   payout_batches%ROWTYPE;
  v_entry   JSONB;
  v_item    payout_items%ROWTYPE;
  v_outcome TEXT;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'apply_payout_sync: p_items must be a JSON array';
  END IF;

  SELECT * INTO v_batch FROM payout_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout batch % not found', p_batch_id;
  END IF;
  IF v_batch.paypal_batch_id IS NULL THEN
    RAISE EXCEPTION 'Payout batch % has not been accepted by PayPal yet', p_batch_id;
  END IF;

  IF p_batch_status IS NOT NULL THEN
    UPDATE payout_batches SET status = lower(p_batch_status) WHERE id = p_batch_id;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_outcome := v_entry->>'outcome';
    IF v_outcome NOT IN ('pending', 'success', 'failed') THEN
      RAISE EXCEPTION 'apply_payout_sync: invalid outcome %', v_outcome;
    END IF;

    SELECT * INTO v_item FROM payout_items
     WHERE id = (v_entry->>'sender_item_id')::UUID AND batch_id = p_batch_id
     FOR UPDATE;
    IF NOT FOUND OR v_item.outcome IN ('success', 'failed') THEN
      CONTINUE; -- unknown item or already final: outcomes only move forward
    END IF;

    UPDATE payout_items SET
      outcome            = v_outcome,
      paypal_item_id     = COALESCE(v_entry->>'paypal_item_id', paypal_item_id),
      transaction_id     = COALESCE(v_entry->>'transaction_id', transaction_id),
      transaction_status = COALESCE(v_entry->>'transaction_status', transaction_status),
      error_message      = CASE WHEN v_outcome = 'failed'
                                THEN left(COALESCE(v_entry->>'error_message', 'PayPal could not complete this payment.'), 500)
                                ELSE error_message END
    WHERE id = v_item.id;

    IF v_outcome IN ('success', 'failed') THEN
      UPDATE bills
         SET status = CASE WHEN v_outcome = 'success' THEN 'paid' ELSE 'payout_failed' END
       WHERE id = v_item.bill_id AND status = 'payout_pending';

      IF FOUND THEN
        INSERT INTO audit_log (bill_id, event, prev_status, new_status, actor, metadata)
        VALUES (v_item.bill_id, 'payout_status', 'payout_pending',
                CASE WHEN v_outcome = 'success' THEN 'paid' ELSE 'payout_failed' END, 'paypal',
                jsonb_build_object(
                  'batch_id', p_batch_id,
                  'paypal_batch_id', v_batch.paypal_batch_id,
                  'transaction_id', v_entry->>'transaction_id',
                  'transaction_status', v_entry->>'transaction_status',
                  'error_message', v_entry->>'error_message'));
      END IF;
    END IF;
  END LOOP;

  UPDATE payout_batches
     SET finished = NOT EXISTS (
           SELECT 1 FROM payout_items WHERE batch_id = p_batch_id AND outcome IN ('queued', 'pending'))
   WHERE id = p_batch_id;
END;
$$;

------------------------------------------------------------------------------
-- reset_demo now also clears payouts.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_demo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE audit_log, flags, payout_items, payout_batches, bills, vendors RESTART IDENTITY CASCADE;
  PERFORM seed_demo_data();
END;
$$;

------------------------------------------------------------------------------
-- Security: RLS on, no policies; functions are server-only.
------------------------------------------------------------------------------
ALTER TABLE payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_items   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payout_batches, payout_items FROM anon, authenticated;

REVOKE ALL ON FUNCTION transition_bill_status(UUID, TEXT, JSONB)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approve_and_create_batch(UUID[], JSONB, TEXT)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mark_batch_submitted(UUID, TEXT, TEXT)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mark_batch_rejected(UUID, TEXT, TEXT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION apply_payout_sync(UUID, TEXT, JSONB)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reset_demo()                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payout_items_guard()                           FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION transition_bill_status(UUID, TEXT, JSONB)     TO service_role;
GRANT EXECUTE ON FUNCTION approve_and_create_batch(UUID[], JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION mark_batch_submitted(UUID, TEXT, TEXT)        TO service_role;
GRANT EXECUTE ON FUNCTION mark_batch_rejected(UUID, TEXT, TEXT)         TO service_role;
GRANT EXECUTE ON FUNCTION apply_payout_sync(UUID, TEXT, JSONB)          TO service_role;
GRANT EXECUTE ON FUNCTION reset_demo()                                  TO service_role;
