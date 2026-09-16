DO $$ DECLARE v_token text; v_req1 bigint; v_req2 bigint; r RECORD; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;

  -- Trigger fetch-weather to re-populate today's slate with fixed PARK_COORDS
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-weather',
    headers := jsonb_build_object('Authorization', 'Bearer '||v_token, 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_req1;
  RAISE NOTICE 'fetch-weather request_id=%', v_req1;

  -- Trigger fetch-statcast-snapshot to re-populate batter+pitcher caches with min=100/50
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-statcast-snapshot',
    headers := jsonb_build_object('Authorization', 'Bearer '||v_token, 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_req2;
  RAISE NOTICE 'fetch-statcast-snapshot request_id=%', v_req2;
END $$;
