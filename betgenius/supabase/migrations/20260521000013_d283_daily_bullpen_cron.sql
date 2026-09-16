-- D-283 SHIP 4 (2026-05-21) — schedule fetch-mlb-bullpen-stats daily.
--
-- Daily 5 AM ET (09:00 UTC), alongside fetch-mlb-batter-splits.
--
-- Rollback:
--   SELECT cron.unschedule('fetch-mlb-bullpen-stats');

DO $$
DECLARE
  v_old bigint;
  v_new bigint;
BEGIN
  SELECT jobid INTO v_old FROM cron.job WHERE jobname = 'fetch-mlb-bullpen-stats' LIMIT 1;
  IF v_old IS NOT NULL THEN
    PERFORM cron.unschedule(v_old);
    RAISE NOTICE '[D-283] unscheduled existing fetch-mlb-bullpen-stats jobid=%', v_old;
  END IF;

  SELECT cron.schedule(
    'fetch-mlb-bullpen-stats',
    '5 9 * * *',  -- 09:05 UTC = 5:05 AM ET (5 min offset from splits cron)
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-bullpen-stats',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
          ),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cmd$
  ) INTO v_new;
  RAISE NOTICE '[D-283] scheduled fetch-mlb-bullpen-stats as jobid=%', v_new;
END $$;

INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('fetch-mlb-bullpen-stats', 'success', now(), 86400)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
