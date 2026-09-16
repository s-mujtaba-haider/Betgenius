-- D-313 SHIP 2 v2 — switch orchestrator crons to vault.decrypted_secrets.
--
-- ROOT CAUSE (deepest, after two prior wrong fixes):
--   * 20260525000009 used `current_setting('app.backfill_auth_token', true)` — GUC NOT SET
--   * 20260525000012 used `current_setting('app.settings.service_role_key', true)` — also NOT SET
--   Verified via 20260525000014 GUC scan: zero GUCs in 'app.*', 'supabase.*', 'pgrst.*' namespaces.
--
-- ACTUAL WORKING PATTERN (used by process-games-mlb-30min, fetch-weather-4h,
-- health-monitor, fetch-odds-mlb-30min):
--   `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)`
--
-- Verified working: process-games-mlb-30min fired at 21:07 UTC and ran for
-- 146s (caught by error_log alert). That confirms the vault auth pattern
-- is the one actually reaching edge functions on this DB.
--
-- The `app.settings.service_role_key` GUC pattern (used by fetch-odds*) is
-- ALSO silently 401'ing — fetch-odds run_log shows zero entries in last 2h
-- despite jobs reporting status=succeeded. pg_cron only checks SQL success,
-- not HTTP status — so a 401 still reports `succeeded`. This is a broader
-- platform observability gap NOT in D-313 scope; fixing only my own crons
-- here.
--
-- Apply via cron.alter_job to preserve jobid + schedule.
--
-- Rollback: re-apply 20260525000012 (returns to the also-broken GUC name).

DO $$
DECLARE
  v_exec_jobid BIGINT;
  v_report_jobid BIGINT;
  v_vault_len INTEGER;
BEGIN
  -- Verify vault secret exists before altering crons
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-313] vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN — abort. Working crons reference this secret; if absent here we have a different problem.';
  END IF;
  RAISE NOTICE '[D-313] vault BACKFILL_AUTH_TOKEN found, length=%', v_vault_len;

  SELECT jobid INTO v_exec_jobid FROM cron.job WHERE jobname = 'orchestrator-execute';
  SELECT jobid INTO v_report_jobid FROM cron.job WHERE jobname = 'orchestrator-daily-report';

  IF v_exec_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_exec_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/orchestrator-execute',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 150000
        );
      $cmd$
    );
    RAISE NOTICE '[D-313] orchestrator-execute (jobid=%) auth switched to vault BACKFILL_AUTH_TOKEN', v_exec_jobid;
  END IF;

  IF v_report_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_report_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/orchestrator-daily-report',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    );
    RAISE NOTICE '[D-313] orchestrator-daily-report (jobid=%) auth switched to vault BACKFILL_AUTH_TOKEN', v_report_jobid;
  END IF;
END $$;
