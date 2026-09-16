-- D-311 SHIP 3 — schedule orchestrator-execute every 30 minutes.
--
-- Enabled after D-311 SHIP 2 fixed the tiered grading logic
-- (binary abortReason→F replaced with A/B/C/D/F based on artifacts
-- produced + stop_reason + cardinal violations). Wall-clock aborts
-- after a successful write_report now grade C, not F.
--
-- Behavior under empty queue: orchestrator-execute returns
-- `{success: true, message: "no_pending_tasks"}` immediately — no
-- side effects, no spend, no DB writes.
--
-- Behavior with a pending task: runs one task per tick (mutex on
-- function_locks ensures only one execution at a time even if a
-- previous run is still in flight).
--
-- Rollback: SELECT cron.unschedule('orchestrator-execute');

DO $$
BEGIN
  PERFORM cron.unschedule('orchestrator-execute')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='orchestrator-execute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'orchestrator-execute',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url', true) || '/functions/v1/orchestrator-execute',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
