-- D-492 SHIP 3 verify: trigger sonnet-health-monitor (the renamed d459 fn)
-- to confirm the new function URL responds end-to-end and writes
-- health_status rows. Same pattern as 20260606000003_d459_test_trigger.sql.
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
END $$;
