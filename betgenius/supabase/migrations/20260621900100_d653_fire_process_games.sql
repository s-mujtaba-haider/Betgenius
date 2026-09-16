-- D-653 SHIP 1 VERIFY — fire process-games-mlb via pg_net + vault BACKFILL_AUTH_TOKEN
-- Captures the request_id so we can correlate with net._http_response.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb';
  v_token TEXT;
  v_req_id BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'BACKFILL_AUTH_TOKEN not in vault';
  END IF;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) INTO v_req_id;
  RAISE NOTICE 'D-653 fire request_id=%', v_req_id;
END $$;
