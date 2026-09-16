-- D-657 SHIP 2 — manually fire snapshot-odds-writer via pg_net to restore line movement.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/snapshot-odds-writer';
  v_token TEXT;
  v_req BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN RAISE EXCEPTION 'BACKFILL_AUTH_TOKEN missing'; END IF;
  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE 'D-657 SHIP 2 fire request_id=%', v_req;
END $$;
