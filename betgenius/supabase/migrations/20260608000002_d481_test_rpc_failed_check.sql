-- D-481 SHIP 3 — verify the new rpc_failed_rate check fires by triggering the
-- d459-sonnet-health function via the vault-auth path (same path the cron uses).
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
END $$;
