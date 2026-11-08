-- 009: assistant plan metadata (spec: .kiro/specs/approval-agent)
-- When the Owner approves bills suggested by the AI Payment Assistant, the batch
-- records the instruction and the AI's summary. The approval itself is unchanged:
-- same validation, same human confirmation.

ALTER TABLE payout_batches
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS assistant_instruction TEXT,
  ADD COLUMN IF NOT EXISTS assistant_summary TEXT;

ALTER TABLE payout_batches DROP CONSTRAINT IF EXISTS payout_batches_source_check;
ALTER TABLE payout_batches ADD CONSTRAINT payout_batches_source_check CHECK (source IN ('manual', 'assistant'));
ALTER TABLE payout_batches DROP CONSTRAINT IF EXISTS payout_batches_instruction_len;
ALTER TABLE payout_batches ADD CONSTRAINT payout_batches_instruction_len CHECK (assistant_instruction IS NULL OR char_length(assistant_instruction) <= 300);
ALTER TABLE payout_batches DROP CONSTRAINT IF EXISTS payout_batches_summary_len;
ALTER TABLE payout_batches ADD CONSTRAINT payout_batches_summary_len CHECK (assistant_summary IS NULL OR char_length(assistant_summary) <= 500);

-- Exactly one approval function: drop the 3-argument version from 008.
DROP FUNCTION IF EXISTS approve_and_create_batch(UUID[], JSONB, TEXT);

CREATE OR REPLACE FUNCTION approve_and_create_batch(
  p_bill_ids  UUID[],
  p_overrides JSONB,
  p_actor     TEXT,
  p_plan      JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_overrides   JSONB := COALESCE(p_overrides, '{}'::jsonb);
  v_problems    JSONB := '[]'::jsonb;
  v_batch_id    UUID;
  v_total       BIGINT := 0;
  v_reason      TEXT;
  v_label       TEXT;
  r             RECORD;
  v_id          UUID;
  v_instruction TEXT := left(NULLIF(btrim(p_plan->>'instruction'), ''), 300);
  v_summary     TEXT := left(NULLIF(btrim(p_plan->>'summary'), ''), 500);
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

  INSERT INTO payout_batches (status, item_count, total_minor_units, currency_code, approved_by,
                              source, assistant_instruction, assistant_summary)
  VALUES ('submitting', cardinality(p_bill_ids), v_total, 'USD', COALESCE(p_actor, 'demo_owner'),
          CASE WHEN v_instruction IS NULL THEN 'manual' ELSE 'assistant' END, v_instruction, v_summary)
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
        'overridden_checks', CASE WHEN r.status = 'flagged' THEN r.flag_names ELSE '[]'::jsonb END,
        'source', CASE WHEN v_instruction IS NULL THEN 'manual' ELSE 'assistant' END,
        'plan_instruction', v_instruction,
        'plan_summary', v_summary
      ));
  END LOOP;

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION approve_and_create_batch(UUID[], JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_and_create_batch(UUID[], JSONB, TEXT, JSONB) TO service_role;
