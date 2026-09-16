DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '──── recent resolve-picks cron fires (12h) ────';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status,
           EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS dur_s
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname IN ('resolve-picks-daily','resolve-picks-nightly','resolve-picks-cleanup','d692-drain-resolver-backlog')
      AND jrd.start_time >= NOW() - INTERVAL '24 hours'
    ORDER BY jrd.start_time DESC LIMIT 30
  LOOP
    RAISE NOTICE 'cron %s start=%s status=%s dur=%ss', r.jobname, r.start_time, r.status, r.dur_s;
  END LOOP;
END $$;
