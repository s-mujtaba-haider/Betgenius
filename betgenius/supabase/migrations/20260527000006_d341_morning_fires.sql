-- D-341 — Add morning fires for fetch-weather + fetch-odds-mlb to populate
-- caches for early-afternoon MLB games (start 13:00 UTC = 9am ET).
--
-- TIMING GAP (current state):
--   fetch-weather-4h schedule:    '0 3,15,19,23 * * *'  UTC (03/15/19/23)
--   fetch-odds-mlb-30min schedule:'0,30 17-23,0-4 * * *' UTC
--   Gap: 04:30 UTC → 17:00 UTC = 12.5 hours.
--
-- IMPACT: per-game scheduler T-3h touches for 13:00 UTC games fire at 10:00 UTC
-- (mid-gap). props_cache stale or empty → skipped odds_stale_*. T-30min at
-- 12:30 UTC same. cache_mlb_game_scoreboard not populated until 15:00 UTC fire
-- → same skip class. Per-game pipeline cannot score early-afternoon games today.
--
-- FIX: add 09:00 UTC fire to BOTH crons (matches spec recommendation Option A).
--   fetch-weather-4h:    '0 3,9,15,19,23 * * *'   — 5 fires/day (was 4)
--   fetch-odds-mlb-30min: keep existing window-cron + new 09:00 UTC standalone fire
--
-- The fetch-odds-mlb-30min cron uses '0,30 17-23,0-4 * * *' which is window-specific.
-- Rather than extending it (would add many redundant fires), schedule a separate
-- fetch-odds-mlb-morning cron at 09:00 UTC. Same function URL, same auth pattern.
--
-- Cost: ~270-360 credits per fetch-odds-mlb call. +1 morning fire = +270/day =
-- ~8K credits/month. Acceptable given the alternative (early-game complete blackout).
--
-- Rollback:
--   UPDATE cron.job SET schedule='0 3,15,19,23 * * *' WHERE jobname='fetch-weather-4h';
--   SELECT cron.unschedule('fetch-odds-mlb-morning');

-- === fetch-weather-4h: extend schedule to include 09:00 UTC ===
DO $$
BEGIN
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname = 'fetch-weather-4h'),
    schedule := '0 3,9,15,19,23 * * *'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'fetch-weather-4h schedule update failed: %', SQLERRM;
END $$;

-- === fetch-odds-mlb-morning: NEW cron at 09:00 UTC daily ===
DO $$
BEGIN
  PERFORM cron.unschedule('fetch-odds-mlb-morning')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-odds-mlb-morning');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'fetch-odds-mlb-morning',
  '0 9 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-odds-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
