DO $$
DECLARE v_rid BIGINT;
BEGIN
  -- Normal-path trigger: confirm the loud-fail patches didn't break the happy path
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_rid;
  RAISE NOTICE '[D-515 verify] resolve-picks normal trigger rid=%', v_rid;
END $$;
