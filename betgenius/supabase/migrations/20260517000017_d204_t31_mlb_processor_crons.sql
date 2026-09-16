-- D-204 Batch 3 Task 3.1 — wake-up MLB processor crons.
--
-- Schedules fetch-odds-mlb + process-games-mlb on game-window cadence.
-- Per CEO Path C, MLB Beta launches Aug 1 2026 — crons start consuming
-- data infrastructure now (T3.0) so by launch we have weeks of cold-
-- start scoring under our belt.
--
-- Cadence (game window: 17:00-04:00 UTC = 1pm-12am ET, covers all MLB):
--   fetch-odds-mlb   — every 30 min during window
--   process-games-mlb — every 30 min, offset by 5 min so it reads fresh props
--
-- Both use vault BACKFILL_AUTH_TOKEN (T3.1 closed the v0 no-auth gap on
-- process-games-mlb; fetch-odds-mlb was already auth'd).

DO $$
DECLARE
  v_jobid BIGINT;
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets
    WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'D-204 T3.1 CRON: vault.BACKFILL_AUTH_TOKEN missing';
  END IF;

  -- fetch-odds-mlb — every 30 min on the half-hour during window
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-odds-mlb-30min') THEN
    SELECT cron.schedule(
      'fetch-odds-mlb-30min',
      '0,30 17-23,0-4 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-odds-mlb',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 T3.1 CRON: scheduled fetch-odds-mlb-30min as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 T3.1 CRON: fetch-odds-mlb-30min already scheduled (skip)';
  END IF;

  -- process-games-mlb — 5 min offset from odds fetch
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-games-mlb-30min') THEN
    SELECT cron.schedule(
      'process-games-mlb-30min',
      '5,35 17-23,0-4 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 180000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-204 T3.1 CRON: scheduled process-games-mlb-30min as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-204 T3.1 CRON: process-games-mlb-30min already scheduled (skip)';
  END IF;
END $$;

DO $$
DECLARE
  job_count INT;
BEGIN
  SELECT COUNT(*) INTO job_count FROM cron.job WHERE jobname IN (
    'fetch-odds-mlb-30min', 'process-games-mlb-30min'
  );
  RAISE NOTICE 'D-204 T3.1 VERIFY: % of 2 MLB processor cron jobs scheduled', job_count;
  IF job_count <> 2 THEN
    RAISE EXCEPTION 'D-204 T3.1 VERIFY FAIL: expected 2 cron jobs, got %', job_count;
  END IF;
END $$;
