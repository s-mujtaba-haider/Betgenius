-- D-664 — one-shot first-run firing for the new caches so the next live cron
-- tick of process-games-mlb (17:00 UTC) finds populated rows.
-- Idempotent: if the fn returns no-op or cron's own run lands first, no harm.
DO $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-664 first-runs deferred.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-team-stats',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  RAISE NOTICE 'D-664 first-run dispatched: fetch-mlb-team-stats (ISO/SLG/AVG populate)';

  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-pen-extras-daily',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 540000
  );
  RAISE NOTICE 'D-664 first-run dispatched: fetch-mlb-pitcher-pen-extras-daily (last3 + pen-rest + BoB populate)';
END $$;
