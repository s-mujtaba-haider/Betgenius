-- D-657 SHIP 1 — fire process-games-mlb post-OOM-fix.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb';
  v_token TEXT;
  v_req BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) INTO v_req;
  RAISE NOTICE 'D-657 SHIP 1 fire request_id=%', v_req;
END $$;
