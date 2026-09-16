-- D-669 SHIP 1 — re-fire inn1 writer post-deploy (initial dispatch during
-- the cron migration fired before the edge fn finished deploying).
DO $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-inn1-daily',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
END $$;
