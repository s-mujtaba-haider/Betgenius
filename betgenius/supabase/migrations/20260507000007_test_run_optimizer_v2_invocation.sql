-- ML Optimizer Phase 6 — test invocation of run-optimizer-v2 (May 7, 2026 evening).
--
-- Per CEO authorization for tonight's batch. Self-contained DO block:
--   1. Reads BACKFILL_AUTH_TOKEN from vault (same source jobid 12 will use)
--   2. Submits net.http_post to run-optimizer-v2
--   3. Polls net._http_response up to 180s
--   4. RAISE NOTICEs the decision + key fields
--
-- This migration produces NO schema changes. It exists to capture a single
-- invocation log line in the Postgres NOTICE stream during `supabase db push`.
-- The actual side effects (notifications_log row, possible algorithm_weights
-- mutation if APPROVE) are produced by the run-optimizer-v2 edge function
-- itself responding to this test ping.
--
-- Per session constraints:
--   - Authorized for Item 2 of tonight's batch
--   - Conditional algorithm_weights mutation ONLY if walk-forward decides
--     APPROVE and gate accepts — this is the sanctioned end-to-end test path

DO $$
DECLARE
  v_token TEXT;
  v_request_id BIGINT;
  v_status INTEGER;
  v_content JSONB;
  v_resp_row RECORD;
  v_attempt INTEGER := 0;
  v_max_attempts CONSTANT INTEGER := 36;  -- 36 * 5s = 180s
  v_url CONSTANT TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/run-optimizer-v2';
BEGIN
  -- Step 1: Read BACKFILL_AUTH_TOKEN from vault
  BEGIN
    SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
    WHERE name = 'BACKFILL_AUTH_TOKEN'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_token := NULL;
  END;

  IF v_token IS NULL OR v_token = '' THEN
    RAISE NOTICE '[Phase 6 test] BACKFILL_AUTH_TOKEN not in vault — cannot test wrapper. Skipping HTTP layer test. Wrapper layer will be first-fire validated by cron Sunday May 10.';
    RETURN;
  END IF;

  RAISE NOTICE '[Phase 6 test] vault token present. Submitting POST to run-optimizer-v2...';

  -- Step 2: Submit POST with 180s timeout
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

  -- Step 3: Poll for response (up to 180s)
  WHILE v_attempt < v_max_attempts LOOP
    PERFORM pg_sleep(5);
    v_attempt := v_attempt + 1;

    SELECT id, status_code, content, error_msg, timed_out
    INTO v_resp_row
    FROM net._http_response
    WHERE id = v_request_id;

    IF FOUND THEN
      v_status := v_resp_row.status_code;
      BEGIN
        v_content := v_resp_row.content::JSONB;
      EXCEPTION WHEN OTHERS THEN
        v_content := jsonb_build_object('parse_error', SQLERRM, 'raw', LEFT(COALESCE(v_resp_row.content::TEXT, '(null)'), 500));
      END;
      RAISE NOTICE '[Phase 6 test] response after %s — status=% timed_out=%', v_attempt * 5, v_status, v_resp_row.timed_out;
      EXIT;
    END IF;
  END LOOP;

  IF v_content IS NULL THEN
    RAISE NOTICE '[Phase 6 test] no response after 180s. request_id=% remains in net._http_response (may arrive later).', v_request_id;
    RETURN;
  END IF;

  -- Step 4: Report key fields
  RAISE NOTICE '[Phase 6 test] decision=% applied=% severity=%',
    v_content->>'decision',
    v_content->>'applied',
    v_content->>'notification_severity';
  RAISE NOTICE '[Phase 6 test] message: %', v_content->>'notification_message';
  RAISE NOTICE '[Phase 6 test] duration_ms=%', v_content->>'duration_ms';

  IF (v_content->>'applied')::BOOLEAN IS TRUE THEN
    RAISE NOTICE '[Phase 6 test] !!! APPROVE+APPLIED — algorithm_weights MUTATED. Verify via SELECT * FROM algorithm_weights WHERE id=1.';
  END IF;
END $$;
