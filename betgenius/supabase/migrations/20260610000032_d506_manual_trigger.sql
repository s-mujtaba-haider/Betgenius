DO $$
DECLARE
  v_rid BIGINT;
  v_vault_len INT;
BEGIN
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL THEN
    RAISE EXCEPTION '[D-506] vault BACKFILL_AUTH_TOKEN missing';
  END IF;

  -- Trigger resolve-picks with empty body (=cron default)
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000
  ) INTO v_rid;
  RAISE NOTICE '[D-506] resolve-picks manual trigger request_id=%', v_rid;
END $$;
