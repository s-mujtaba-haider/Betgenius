-- ML Optimizer Phase 6 — test run-optimizer-v2 via the same GUC auth pattern
-- jobid 12 uses (May 7, 2026 evening). 20260507000007 was a no-op because
-- vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN entry; the live token
-- lives in current_setting('app.backfill_auth_token', true), confirmed by
-- the diagnostic migration 20260507000008.
--
-- This migration produces no schema changes. Side effects (notifications_log
-- row, possible algorithm_weights mutation if walk-forward decides APPROVE)
-- are produced inside run-optimizer-v2.
--
-- Per session constraints: Item 2 of tonight's batch authorized end-to-end
-- HTTP test including conditional weight change on APPROVE.

DO $$
DECLARE
  v_token TEXT;
  v_request_id BIGINT;
  v_resp_row RECORD;
  v_content JSONB := NULL;
  v_attempt INTEGER := 0;
  v_max_attempts CONSTANT INTEGER := 36;  -- 36 * 5s = 180s
  v_url CONSTANT TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/run-optimizer-v2';
BEGIN
  v_token := current_setting('app.backfill_auth_token', true);

  IF v_token IS NULL OR v_token = '' THEN
    RAISE NOTICE '[Phase 6 test] app.backfill_auth_token GUC empty — cannot test wrapper. SKIP.';
    RETURN;
  END IF;

  RAISE NOTICE '[Phase 6 test] GUC token len=% — submitting POST to run-optimizer-v2...', LENGTH(v_token);

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := '{}'::JSONB,
    timeout_milliseconds := 180000
  ) INTO v_request_id;

  RAISE NOTICE '[Phase 6 test] request_id=%', v_request_id;

  WHILE v_attempt < v_max_attempts LOOP
    PERFORM pg_sleep(5);
    v_attempt := v_attempt + 1;

    SELECT id, status_code, content, error_msg, timed_out
    INTO v_resp_row
    FROM net._http_response
    WHERE id = v_request_id;

    IF FOUND THEN
      RAISE NOTICE '[Phase 6 test] response after %s — status=% timed_out=% err=%',
        v_attempt * 5, v_resp_row.status_code, v_resp_row.timed_out,
        COALESCE(v_resp_row.error_msg, '(none)');
      BEGIN
        v_content := v_resp_row.content::JSONB;
      EXCEPTION WHEN OTHERS THEN
        v_content := NULL;
        RAISE NOTICE '[Phase 6 test] content not JSONB. raw (first 800): %',
          LEFT(COALESCE(v_resp_row.content::TEXT, '(null)'), 800);
      END;
      EXIT;
    END IF;
  END LOOP;

  IF v_content IS NULL THEN
    IF v_resp_row.id IS NULL THEN
      RAISE NOTICE '[Phase 6 test] no response after 180s. request_id=% may arrive later.', v_request_id;
    END IF;
    RETURN;
  END IF;

  RAISE NOTICE '[Phase 6 test] decision=% applied=% severity=%',
    v_content->>'decision',
    v_content->>'applied',
    v_content->>'notification_severity';
  RAISE NOTICE '[Phase 6 test] message: %', v_content->>'notification_message';
  RAISE NOTICE '[Phase 6 test] duration_ms=%', v_content->>'duration_ms';

  IF (v_content->>'applied')::BOOLEAN IS TRUE THEN
    RAISE NOTICE '[Phase 6 test] !!! APPROVE+APPLIED — algorithm_weights MUTATED.';
  END IF;
END $$;
