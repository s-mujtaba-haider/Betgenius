-- D-331 Phase C SHIP 3 — schedule register-game-schedule HOURLY.
--
-- Cadence: '15 * * * *' (every hour at :15) per D-328 FLAG 1 finding.
-- HOURLY (not daily) so late-added games and postponements are caught
-- within 60 min of MLB publishing them.
--
-- Vault-based auth (D-313 pattern). Verified via net._http_response
-- showing HTTP 200 — NOT the broken current_setting('app.*') GUC.
--
-- Rollback: SELECT cron.unschedule('register-game-schedule-hourly');

DO $$
BEGIN
  PERFORM cron.unschedule('register-game-schedule-hourly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'register-game-schedule-hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'register-game-schedule-hourly',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/register-game-schedule',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
