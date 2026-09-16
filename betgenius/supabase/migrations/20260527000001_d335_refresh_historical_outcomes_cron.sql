-- D-335 SHIP 0 — schedule daily refresh of cache_mlb_historical_outcomes at 04:00 UTC.
--
-- Closes the D-334 follow-up gap: without ongoing refresh, the L10 cache decays
-- by ~1 game per team per day. This cron re-ingests the last 3 UTC days
-- (handles late-completing games + suspended-game finish-the-next-day case).
--
-- Vault-based auth per D-313 pattern (jobid=33 / jobid=34 / jobid=35 verified working).
-- pg_net.http_post is async — pg_cron reports succeeded on SQL completion not HTTP
-- outcome. Real result lands in net._http_response.
--
-- Rollback: SELECT cron.unschedule('refresh-historical-outcomes-mlb-daily');

DO $$
BEGIN
  PERFORM cron.unschedule('refresh-historical-outcomes-mlb-daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-historical-outcomes-mlb-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'refresh-historical-outcomes-mlb-daily',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/refresh-historical-outcomes-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('days_back', 3),
    timeout_milliseconds := 90000
  );
  $$
);
