DO $$ DECLARE r RECORD; v_req_id bigint; v_token text; BEGIN
  -- Get the BACKFILL_AUTH_TOKEN from vault
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN not found in vault';
    RETURN;
  END IF;

  -- Manually invoke resolve-picks with limit=10, sport=mlb, since_days=14
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('limit', 10, 'sport', 'mlb', 'since_days', 14),
    timeout_milliseconds := 90000
  ) INTO v_req_id;
  RAISE NOTICE 'request_id=%', v_req_id;

  -- Wait briefly for the response
  PERFORM pg_sleep(15);

  -- Read the response
  FOR r IN
    SELECT id, status_code, LEFT(content::text, 2000) AS body, created
      FROM net._http_response
     WHERE id = v_req_id
  LOOP
    RAISE NOTICE 'status=% body=%', r.status_code, r.body;
  END LOOP;
END $$;
