-- D-282 SHIP 2 (2026-05-21) — schedule fetch-baseball-savant-weekly cron.
--
-- Weekly Sunday 4 AM ET (08:00 UTC). Pulls 4 Baseball Savant
-- framing leaderboards into unified cache_statcast_framing table.
--
-- Rollback:
--   SELECT cron.unschedule('fetch-baseball-savant-weekly');

DO $$
DECLARE
  v_old bigint;
  v_new bigint;
BEGIN
  SELECT jobid INTO v_old FROM cron.job WHERE jobname = 'fetch-baseball-savant-weekly' LIMIT 1;
  IF v_old IS NOT NULL THEN
    PERFORM cron.unschedule(v_old);
    RAISE NOTICE '[D-282] unscheduled existing fetch-baseball-savant-weekly jobid=%', v_old;
  END IF;

  SELECT cron.schedule(
    'fetch-baseball-savant-weekly',
    '0 8 * * 0',  -- Sunday 08:00 UTC = Sunday 4 AM ET
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-baseball-savant-weekly',
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
  RAISE NOTICE '[D-282] scheduled fetch-baseball-savant-weekly as jobid=%', v_new;
END $$;

-- Seed cron_heartbeat row
INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('fetch-baseball-savant-weekly', 'success', now(), 604800)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
