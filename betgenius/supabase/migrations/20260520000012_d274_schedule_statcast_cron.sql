-- D-274 Phase 1 (2026-05-20) — schedule daily fetch-statcast-snapshot cron.
--
-- 8:00 UTC = 4:00 AM ET = before the noon MLB scoring window so
-- today's xstats / exit velo snapshots are available to process-games-mlb.
--
-- Uses the canonical vault-backed BACKFILL_AUTH_TOKEN pattern that
-- D-273-OPPSTATS established as the working schedule format.
--
-- Rollback:
--   SELECT cron.unschedule('fetch-statcast-snapshot');

DO $$
DECLARE
  v_old_jobid bigint;
  v_new_jobid bigint;
BEGIN
  SELECT jobid INTO v_old_jobid FROM cron.job WHERE jobname = 'fetch-statcast-snapshot' LIMIT 1;
  IF v_old_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_old_jobid);
    RAISE NOTICE '[D-274] unscheduled existing fetch-statcast-snapshot jobid=%', v_old_jobid;
  END IF;

  SELECT cron.schedule(
    'fetch-statcast-snapshot',
    '0 8 * * *',   -- 08:00 UTC daily (4:00 AM ET)
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-statcast-snapshot',
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
  ) INTO v_new_jobid;
  RAISE NOTICE '[D-274] scheduled fetch-statcast-snapshot as jobid=%', v_new_jobid;
END $$;

-- Seed cron_heartbeat row so detect_silent_crons can observe it
INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('fetch-statcast-snapshot', 'success', now(), 86400)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
