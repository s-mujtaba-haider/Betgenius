DO $$
DECLARE v_rid BIGINT; v_body TEXT; v_status INT;
BEGIN
  -- Hit the RPC via HTTPS using BACKFILL_AUTH_TOKEN (same auth the cron uses)
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/rest/v1/rpc/d515_props_cache_velocity',
    headers := jsonb_build_object(
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO v_rid;
  PERFORM pg_sleep(8);
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code INTO v_body, v_status
   FROM net._http_response WHERE id = v_rid;
  RAISE NOTICE '[D-515 RPC http test] status=% body=%', v_status, COALESCE(v_body, '<null>');
END $$;
