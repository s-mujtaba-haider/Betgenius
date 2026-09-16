DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-514 break] last 5 jobid 46 (capture-closing-odds) failure details:';
  FOR r IN
    SELECT jrd.start_time, jrd.status, jrd.return_message
    FROM cron.job_run_details jrd
    WHERE jrd.jobid = 46
    ORDER BY jrd.start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  at=% status=% msg=%',
    r.start_time, r.status, left(COALESCE(r.return_message, '<null>'), 400); END LOOP;
END $$;
