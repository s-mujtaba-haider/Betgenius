DO $$
DECLARE v_rid BIGINT;
BEGIN
  -- Re-run the diagnose flow to confirm the picks query now returns 200 rows
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{"diagnose_picks_query": true}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_rid;
  RAISE NOTICE '[D-506] post-index diagnose trigger request_id=%', v_rid;
END $$;
