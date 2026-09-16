DO $$
DECLARE v_rid BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_rid;
  RAISE NOTICE '[D-515 verify] sonnet-health-monitor trigger rid=%', v_rid;
END $$;
