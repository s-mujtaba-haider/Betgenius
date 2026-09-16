-- D-204 Batch 3 Task 3.0 — MLB cron schedule.
--
-- Schedules 5 new pg_cron jobs (logical jobids 18-22) for MLB data
-- pipelines. pg_cron auto-assigns physical jobids; we use jobname for
-- idempotency. Vault-auth pattern per D-108.
--
-- Cron map per D-203 spec:
--   18 — fetch-mlb-pitcher-stats — daily 12:00 UTC
--   19 — fetch-mlb-team-stats    — daily 12:30 UTC
--   20 — fetch-ballpark-factors  — weekly Mon 11:00 UTC (CEO decision #3)
--   21 — fetch-umpire-stats      — daily 11:30 UTC (CEO decision #2)
--   22 — fetch-weather           — every 4h during game window (15,19,23,03 UTC)
--
-- Wake-up of dormant jobs (jobid 4 process-games-mlb, jobid 5 fetch-odds-mlb)
-- is deferred to per-market tasks 3.1+ — those jobs already exist but are
-- disabled per D-120.

DO $$
DECLARE
  v_jobid BIGINT;
  v_token TEXT;
BEGIN
  -- Sanity: vault token must exist or every cron will 401.
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets
    WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'D-204 CRON: vault.BACKFILL_AUTH_TOKEN missing — aborting cron schedule';
  END IF;

  -- 18: fetch-mlb-pitcher-stats — daily 12:00 UTC
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-pitcher-stats-daily') THEN
    SELECT cron.schedule(
      'fetch-mlb-pitcher-stats-daily',
      '0 12 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-stats',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 CRON: scheduled fetch-mlb-pitcher-stats-daily as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 CRON: fetch-mlb-pitcher-stats-daily already scheduled (skip)';
  END IF;

  -- 19: fetch-mlb-team-stats — daily 12:30 UTC
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-team-stats-daily') THEN
    SELECT cron.schedule(
      'fetch-mlb-team-stats-daily',
      '30 12 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-team-stats',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 90000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 CRON: scheduled fetch-mlb-team-stats-daily as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 CRON: fetch-mlb-team-stats-daily already scheduled (skip)';
  END IF;

  -- 20: fetch-ballpark-factors — weekly Mon 11:00 UTC (CEO decision #3)
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-ballpark-factors-weekly') THEN
    SELECT cron.schedule(
      'fetch-ballpark-factors-weekly',
      '0 11 * * 1',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-ballpark-factors',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 CRON: scheduled fetch-ballpark-factors-weekly as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 CRON: fetch-ballpark-factors-weekly already scheduled (skip)';
  END IF;

  -- 21: fetch-umpire-stats — daily 11:30 UTC (CEO decision #2)
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-umpire-stats-daily') THEN
    SELECT cron.schedule(
      'fetch-umpire-stats-daily',
      '30 11 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-umpire-stats',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 CRON: scheduled fetch-umpire-stats-daily as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 CRON: fetch-umpire-stats-daily already scheduled (skip)';
  END IF;

  -- 22: fetch-weather — every 4h during game window (15, 19, 23, 03 UTC)
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-weather-4h') THEN
    SELECT cron.schedule(
      'fetch-weather-4h',
      '0 3,15,19,23 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-weather',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 CRON: scheduled fetch-weather-4h as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 CRON: fetch-weather-4h already scheduled (skip)';
  END IF;
END $$;

-- Verification: confirm all 5 jobs registered
DO $$
DECLARE
  job_count INT;
BEGIN
  SELECT COUNT(*) INTO job_count FROM cron.job WHERE jobname IN (
    'fetch-mlb-pitcher-stats-daily', 'fetch-mlb-team-stats-daily',
    'fetch-ballpark-factors-weekly', 'fetch-umpire-stats-daily',
    'fetch-weather-4h'
  );
  RAISE NOTICE 'D-204 VERIFY: % of 5 MLB cron jobs scheduled', job_count;
  IF job_count <> 5 THEN
    RAISE EXCEPTION 'D-204 VERIFY FAIL: expected 5 cron jobs, got %', job_count;
  END IF;
END $$;
