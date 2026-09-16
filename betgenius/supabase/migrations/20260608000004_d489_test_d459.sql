-- D-489 STAGE 5 verify: trigger d459-sonnet-health to confirm the new
-- pick_history_validation_failed_rate check runs alongside the existing 5.
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/d459-sonnet-health',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
END $$;
