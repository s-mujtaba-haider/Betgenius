-- D-330 Phase B SHIP 3 — schedule job-dispatcher every 1 minute.
--
-- Uses the SAME vault-based auth pattern that D-313 SHIP 2 v2 established
-- as the actually-working approach (verified by orchestrator-execute cron
-- jobid=33 + orchestrator-daily-report jobid=32 functioning correctly).
--
-- DO NOT use the broken GUC patterns (`current_setting('app.backfill_auth_token')`
-- or `current_setting('app.settings.service_role_key')`) — both are unset on this
-- DB per D-313 diagnostic 20260525000014.
--
-- pg_net.http_post is async — pg_cron reports succeeded on the SQL completion,
-- not the HTTP outcome. Real HTTP outcome is in net._http_response (D-313 lesson).
--
-- Rollback: `SELECT cron.unschedule('job-dispatcher-1min');`

DO $$
BEGIN
  PERFORM cron.unschedule('job-dispatcher-1min')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-dispatcher-1min');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'job-dispatcher-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/job-dispatcher',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
