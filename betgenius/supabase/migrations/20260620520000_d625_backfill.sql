-- D-625 backfill — non-blocking; fires HTTP calls and exits without waiting.
-- The cron jobs + these async calls drain the queue. Subsequent verify
-- migrations check the AFTER count.
DO $$ DECLARE v_token text; v_req bigint; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  -- Fire 5 resolver invocations back-to-back (pg_net is async, returns immediately).
  FOR i IN 1..5 LOOP
    SELECT net.http_post(
      url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
      body := jsonb_build_object('limit', 100, 'sport', 'mlb', 'since_days', 14),
      timeout_milliseconds := 120000
    ) INTO v_req;
    RAISE NOTICE '  backfill invocation % req=%', i, v_req;
  END LOOP;
END $$;
