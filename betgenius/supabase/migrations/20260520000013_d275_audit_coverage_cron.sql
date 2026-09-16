-- D-275-AUDIT-GAP (2026-05-20) — schedule audit-resolution-coverage daily.
--
-- Runs at 14:00 UTC (10 AM ET), well after the final resolve-picks tick
-- of the day (last NBA resolve at 05:30 UTC; MLB resolve runs via the
-- main resolve-picks cron throughout the night). Coverage check uses
-- a 14-day lookback window; alerts via notifications_log when stale
-- unresolved >10% of total AND ≥20 stale rows.
--
-- Closes the D-265 audit-spec gap that allowed D-274 to surface 3,351
-- unresolved MLB picks without any alert firing. Going forward, this
-- check fires daily and would catch a re-occurrence within 24h.
--
-- Rollback:
--   SELECT cron.unschedule('audit-resolution-coverage');

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'audit-resolution-coverage' LIMIT 1;
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  SELECT cron.schedule(
    'audit-resolution-coverage',
    '0 14 * * *',  -- 14:00 UTC daily
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/audit-resolution-coverage',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
          ),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $cmd$
  ) INTO v_jobid;
  RAISE NOTICE '[D-275-AUDIT-GAP] scheduled audit-resolution-coverage as jobid=%', v_jobid;
END $$;

-- Seed cron_heartbeat row
INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('audit-resolution-coverage', 'success', now(), 86400)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
