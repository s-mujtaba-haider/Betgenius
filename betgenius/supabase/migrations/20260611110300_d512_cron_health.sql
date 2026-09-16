DO $$
DECLARE r RECORD;
BEGIN
  -- Cron run health: did jobid 21 (process-games-mlb), 46 (capture-closing-odds),
  -- 20 (fetch-odds-mlb) fire recently?
  RAISE NOTICE '[D-512 cron] last 3 runs each for key crons (24h):';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status
    FROM cron.job j
    JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname IN (
      'process-games-mlb-30min', 'capture-closing-odds-mlb-5min',
      'fetch-odds-mlb-30min', 'resolve-picks-daily',
      'resolve-picks-cleanup', 'resolve-picks-nightly'
    )
    AND jrd.start_time > NOW() - INTERVAL '24 hours'
    ORDER BY j.jobname, jrd.start_time DESC LIMIT 30
  LOOP RAISE NOTICE '  job=% at=% status=%', r.jobname, r.start_time, r.status; END LOOP;

  -- Any backfill cron leftover? (D-506 should have unscheduled)
  RAISE NOTICE '[D-512 cron] backfill cron leftover check (should be empty):';
  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname ILIKE '%backfill%' OR jobname ILIKE '%d506%'
  LOOP RAISE NOTICE '  LEFTOVER jobid=% name=%', r.jobid, r.jobname; END LOOP;
END $$;
