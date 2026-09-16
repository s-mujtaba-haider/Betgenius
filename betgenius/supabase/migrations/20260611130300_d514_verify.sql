DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '600s';

  RAISE NOTICE '[D-514 verify] last 5 jobid 46 (capture) runs:';
  FOR r IN
    SELECT start_time, status, left(COALESCE(return_message, '<null>'), 200) AS msg
    FROM cron.job_run_details
    WHERE jobid = 46 ORDER BY start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  at=% status=% msg=%', r.start_time, r.status, r.msg; END LOOP;

  RAISE NOTICE '[D-514 verify] last 5 jobid 21 (process-games-mlb) runs:';
  FOR r IN
    SELECT start_time, status FROM cron.job_run_details
    WHERE jobid = 21 ORDER BY start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  at=% status=%', r.start_time, r.status; END LOOP;

  -- CLV stamps fresh after fix?
  RAISE NOTICE '[D-514 verify] CLV stamps in last 5 min (D-511 health):';
  FOR r IN
    SELECT count(*) AS stamps_5min,
           max(closing_captured_at) AS last_stamp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND closing_captured_at > NOW() - INTERVAL '5 minutes'
  LOOP RAISE NOTICE '  stamps_5min=% last=%', r.stamps_5min, r.last_stamp; END LOOP;
END $$;
