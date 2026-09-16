-- D-349 — schedule fetch-mlb-pitcher-splits daily.
--
-- Daily 05:30 UTC (1:30 AM ET — after statcast snapshot 08:00 UTC waits for
-- early-AM data, before fetch-odds-mlb-morning 09:00 UTC, no overlap with
-- batter-splits 09:00 UTC).
--
-- Source: today's pitcher_strikeouts pool from props_cache UNION today's
-- probable pitchers from MLB schedule (probablePitcher hydrate). ~30-60
-- pitchers per run × ~250ms = ~15s wall.
--
-- Vault-auth pattern (D-313).
--
-- Rollback:
--   SELECT cron.unschedule('fetch-mlb-pitcher-splits');

DO $$
DECLARE
  v_old bigint;
  v_new bigint;
BEGIN
  SELECT jobid INTO v_old FROM cron.job WHERE jobname = 'fetch-mlb-pitcher-splits' LIMIT 1;
  IF v_old IS NOT NULL THEN
    PERFORM cron.unschedule(v_old);
    RAISE NOTICE '[D-349] unscheduled existing fetch-mlb-pitcher-splits jobid=%', v_old;
  END IF;

  SELECT cron.schedule(
    'fetch-mlb-pitcher-splits',
    '30 5 * * *',  -- 05:30 UTC daily
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-splits',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
          ),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$
  ) INTO v_new;
  RAISE NOTICE '[D-349] scheduled fetch-mlb-pitcher-splits as jobid=%', v_new;
END $$;

INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('fetch-mlb-pitcher-splits', 'success', now(), 86400)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
