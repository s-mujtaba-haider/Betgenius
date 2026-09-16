DO $$ DECLARE r RECORD; v_req bigint; v_token text; v_start timestamptz; v_ms numeric; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  v_start := clock_timestamp();
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('limit', 100, 'sport', 'mlb', 'since_days', 14),
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE 'req=%', v_req;
  PERFORM pg_sleep(60);
  v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
  RAISE NOTICE 'sleep done — %ms elapsed', v_ms;
  FOR r IN SELECT id, status_code, regexp_replace(LEFT(COALESCE(content::text,''),600), E'[\\n\\r]+', ' ', 'g') AS body FROM net._http_response WHERE id = v_req LOOP
    RAISE NOTICE '  resp status=% body=%', r.status_code, r.body;
  END LOOP;
END $$;
