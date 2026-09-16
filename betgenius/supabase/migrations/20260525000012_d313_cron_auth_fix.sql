-- D-313 SHIP 2 — fix orchestrator cron auth.
--
-- ROOT CAUSE: migration 20260525000009 used `current_setting('app.backfill_auth_token', true)`,
-- but that GUC is NOT SET on this database. Confirmed via diagnostic
-- migration 20260525000011 — output was:
--   [D-313] app.backfill_auth_token GUC: NOT SET (empty/null)
--
-- With missing_ok=true, the call returned NULL → `Bearer ` (trailing space, empty token).
-- The orchestrator-execute function's auth check at line 345 of index.ts uses
-- `auth.includes(SUPABASE_KEY) || auth.includes(BACKFILL_TOKEN)`. An empty-token
-- header matches NEITHER (since both env vars are non-empty strings). Function
-- returns 401 in ~44ms with zero DB writes. This is the 44ms cron exit pattern.
--
-- WORKING PATTERN: the 27 healthy crons (e.g., fetch-odds-every-15min) use
-- `current_setting('app.settings.service_role_key', true)`. This GUC IS set
-- on this database and contains the service role key. Function accepts it
-- (matches SUPABASE_KEY via includes()).
--
-- FIX: switch both orchestrator crons (jobid=32 orchestrator-daily-report,
-- jobid=33 orchestrator-execute) to use app.settings.service_role_key.
-- Apply via cron.alter_job to preserve jobid + schedule.
--
-- Rollback: re-apply 20260525000009 (returns to the broken GUC name).

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
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 150000
        );
      $cmd$
    );
    RAISE NOTICE '[D-313] orchestrator-execute (jobid=%) auth switched to app.settings.service_role_key', v_exec_jobid;
  END IF;

  IF v_report_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_report_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/orchestrator-daily-report',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    );
    RAISE NOTICE '[D-313] orchestrator-daily-report (jobid=%) auth switched to app.settings.service_role_key', v_report_jobid;
  END IF;
END $$;
