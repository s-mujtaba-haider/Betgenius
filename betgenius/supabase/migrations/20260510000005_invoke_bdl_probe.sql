-- Invoke bdl-injuries-probe edge function via vault auth + capture response.
-- Read-only — no DB mutations beyond the pg_net request log.

DO $$
DECLARE
  v_token TEXT;
  v_request_id BIGINT;
  v_resp_row RECORD;
  v_content_text TEXT;
  v_attempt INTEGER := 0;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;

  IF v_token IS NULL THEN
    RAISE NOTICE 'vault BACKFILL_AUTH_TOKEN missing — cannot invoke probe';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/bdl-injuries-probe',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := '{}'::JSONB,
    timeout_milliseconds := 30000
  ) INTO v_request_id;

  RAISE NOTICE 'request_id=%, waiting for response...', v_request_id;

  WHILE v_attempt < 12 LOOP
    PERFORM pg_sleep(3);
    v_attempt := v_attempt + 1;
    SELECT id, status_code, content, error_msg, timed_out
    INTO v_resp_row
    FROM net._http_response WHERE id = v_request_id;
    IF FOUND THEN
      RAISE NOTICE 'response after %s — http_status=% timed_out=%',
        v_attempt * 3, v_resp_row.status_code, v_resp_row.timed_out;
      v_content_text := v_resp_row.content::TEXT;
      RAISE NOTICE 'response body (full): %', v_content_text;
      EXIT;
    END IF;
  END LOOP;

  IF v_content_text IS NULL THEN
    RAISE NOTICE 'no response after 36s';
  END IF;
END $$;
