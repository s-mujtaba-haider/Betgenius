-- D-311 SHIP 3 FIX — orchestrator-execute cron failed on first firing.
--
-- Root cause: 20260525000008 used `current_setting('app.supabase_url', true)`
-- and `current_setting('app.supabase_service_role_key', true)`, but neither
-- GUC is configured on this database. With `missing_ok=true`, the call
-- returned NULL, which made `url` NULL after concatenation, and
-- `net.http_post(url := NULL, ...)` failed in 48ms.
--
-- Fix: switch to the pattern the 27 other working crons use — hardcode
-- the URL and use `app.backfill_auth_token` for the auth header. The
-- orchestrator-execute function accepts BACKFILL_AUTH_TOKEN as an
-- alternative to SUPABASE_SERVICE_ROLE_KEY (line 345 of index.ts).
--
-- D-306 daily-report cron (20260525000006) has the same bug but hasn't
-- fired yet (schedule is 13:00 UTC daily). That migration is patched
-- with the same alter_job in this file.
--
-- Rollback: `cron.unschedule('orchestrator-execute');` and
--           `cron.unschedule('orchestrator-daily-report');`

DO $$
DECLARE
  v_exec_jobid BIGINT;
  v_report_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_exec_jobid FROM cron.job WHERE jobname = 'orchestrator-execute';
  SELECT jobid INTO v_report_jobid FROM cron.job WHERE jobname = 'orchestrator-daily-report';

  IF v_exec_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_exec_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/orchestrator-execute',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.backfill_auth_token', true),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 150000
        );
      $cmd$
    );
    RAISE NOTICE 'orchestrator-execute (jobid=%) command updated', v_exec_jobid;
  END IF;

  IF v_report_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_report_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/orchestrator-daily-report',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.backfill_auth_token', true),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    );
    RAISE NOTICE 'orchestrator-daily-report (jobid=%) command updated', v_report_jobid;
  END IF;
END $$;
