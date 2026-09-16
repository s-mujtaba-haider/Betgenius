-- D-729 — trigger fetch-mlb-boxscores backfill using the correct vault secret.
DO $$
DECLARE v_token text; v_resp_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'BACKFILL_AUTH_TOKEN secret missing';
  END IF;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-boxscores',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body := jsonb_build_object('days_back', 7),
    timeout_milliseconds := 150000
  ) INTO v_resp_id;
  RAISE NOTICE 'D-729: fetch-mlb-boxscores triggered, net.http_post id=%', v_resp_id;
END $$;
