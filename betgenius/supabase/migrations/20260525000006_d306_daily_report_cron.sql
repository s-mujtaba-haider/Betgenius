-- D-306 Phase 5 — schedule daily orchestrator report at 8 AM ET (13:00 UTC).
--
-- orchestrator-execute cron INTENTIONALLY NOT scheduled this batch
-- per Phase 4 honest scope (Claude API integration deferred to D-307).
-- CEO can manually invoke orchestrator-execute for testing; cron will
-- be scheduled in D-307 once execution actually does meaningful work.
--
-- Rollback: SELECT cron.unschedule('orchestrator-daily-report');

DO $$
BEGIN
  PERFORM cron.unschedule('orchestrator-daily-report')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='orchestrator-daily-report');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'orchestrator-daily-report',
  '0 13 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url', true) || '/functions/v1/orchestrator-daily-report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
