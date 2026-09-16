DO $$
DECLARE v_rid BIGINT; r RECORD; v_now TIMESTAMPTZ; v_active BOOLEAN;
BEGIN
  v_now := NOW();
  RAISE NOTICE '[D-508 test] current UTC: %', v_now;

  -- Check if process-games-mlb-30min cron is in its active window
  -- Schedule: */5 17-23,0-4 * * * UTC
  SELECT EXTRACT(HOUR FROM v_now) BETWEEN 0 AND 4 OR EXTRACT(HOUR FROM v_now) BETWEEN 17 AND 23
    INTO v_active;
  RAISE NOTICE '[D-508 test] active window? %', v_active;

  -- Last 5 process-games-mlb-30min cron runs
  RAISE NOTICE '[D-508 test] last 5 jobid=21 cron runs:';
  FOR r IN SELECT start_time, status FROM cron.job_run_details
   WHERE jobid = 21 ORDER BY start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  start=% status=%', r.start_time, r.status; END LOOP;

  -- Manual trigger now to validate the volume-shard path
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 200000
  ) INTO v_rid;
  RAISE NOTICE '[D-508 test] manual trigger request_id=%', v_rid;
END $$;
