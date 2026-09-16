-- D-335 SHIP 3 — daily fetch-mlb-boxscores cron at 04:30 UTC.
--
-- Runs 30 min after refresh-historical-outcomes-mlb-daily so that cron has
-- populated yesterday's completed games into cache_mlb_historical_outcomes
-- (the source set this function reads).
--
-- Vault-based auth per D-313 pattern.
--
-- Rollback: SELECT cron.unschedule('fetch-mlb-boxscores-daily');

DO $$
BEGIN
  PERFORM cron.unschedule('fetch-mlb-boxscores-daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-boxscores-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'fetch-mlb-boxscores-daily',
  '30 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-boxscores',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('days_back', 2),
    timeout_milliseconds := 150000
  );
  $$
);
