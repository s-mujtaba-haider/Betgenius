-- Re-invoke probe v2 (paginated full-corpus aggregate).
DO $$
DECLARE
  v_token TEXT;
  v_request_id BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets
  WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN RAISE NOTICE 'no vault token'; RETURN; END IF;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/bdl-player-injuries-probe',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := '{}'::JSONB,
    timeout_milliseconds := 60000
  ) INTO v_request_id;
  RAISE NOTICE 'v2 request_id=%', v_request_id;
END $$;
