-- D-338 SHIP 3 — daily sweep of stuck status='live' rows in
-- cache_mlb_game_scoreboard. Runs at 06:00 UTC (after all West Coast
-- late games end at 04-05 UTC).
--
-- Backfill at deploy time: manually triggered with days_back=14 to clear
-- the existing 29 stuck rows (all confirmed 'final' per MLB API).
--
-- Vault-based auth per D-313 pattern.
--
-- Rollback: SELECT cron.unschedule('refresh-mlb-scoreboard-status-daily');

DO $$
BEGIN
  PERFORM cron.unschedule('refresh-mlb-scoreboard-status-daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mlb-scoreboard-status-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'refresh-mlb-scoreboard-status-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/refresh-mlb-scoreboard-status',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('days_back', 3),
    timeout_milliseconds := 150000
  );
  $$
);
