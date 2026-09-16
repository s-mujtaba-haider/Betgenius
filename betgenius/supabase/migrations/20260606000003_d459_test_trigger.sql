-- D-459 one-off trigger: invokes d459-sonnet-health using the same vault auth
-- path the production cron uses, so we can verify the function writes real
-- ok/warn/fail rows to health_status without waiting for the :07 cron tick.
--
-- This migration is a verification-only no-op after it runs once
-- (net.http_post is async; subsequent re-applies are harmless).
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/d459-sonnet-health',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  RAISE NOTICE '[D-459 test] http_post enqueued; check health_status table in ~5s';
END $$;
