DO $$
DECLARE r RECORD; v_rid BIGINT; v_body TEXT; v_status INT;
BEGIN
  RAISE NOTICE '[D-515 final test] check no-auth RPC response:';
  FOR r IN
    SELECT id, status_code, left(content::text, 200) AS body
    FROM net._http_response WHERE id = 16160
  LOOP RAISE NOTICE '  rid=% status=% body=%', r.id, r.status_code, r.body; END LOOP;

  -- Re-trigger the health monitor
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_rid;
  RAISE NOTICE '[D-515 final test] health-monitor rid=%', v_rid;
END $$;
