DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-513 §3a] cron run_log: succeeded but zero-work patterns last 24h:';
  FOR r IN
    SELECT j.jobname, count(*) AS total_runs, count(*) FILTER (WHERE jrd.status='succeeded') AS succeeded
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE jrd.start_time > NOW() - INTERVAL '24 hours'
    GROUP BY j.jobname ORDER BY total_runs DESC LIMIT 30
  LOOP RAISE NOTICE '  job=% total=% succ=%', r.jobname, r.total_runs, r.succeeded; END LOOP;

  -- Now look at the recent process-games-mlb response messages for "skipped" patterns
  RAISE NOTICE '[D-513 §3b] recent process-games-mlb response patterns (last 12h):';
  FOR r IN
    SELECT
      CASE WHEN substring(content::text, 1, 60) ILIKE '%skipped%' THEN 'SKIPPED'
           WHEN content::text ILIKE '%picks_scored%' THEN 'WORKED'
           ELSE 'OTHER' END AS pattern,
      count(*) AS n
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '12 hours'
      AND content::text LIKE '%process-games-mlb%' OR
      (length(content::text) BETWEEN 80 AND 400 AND content::text ILIKE '%mlb%')
    GROUP BY pattern
  LOOP RAISE NOTICE '  pattern=% n=%', r.pattern, r.n; END LOOP;

  -- D-507-style check: any cron has status=succeeded but did 0 work for >2h?
  RAISE NOTICE '[D-513 §3c] capture-closing-odds last fires (when in window):';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status, jrd.return_message
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname='capture-closing-odds-mlb-5min'
      AND jrd.start_time > NOW() - INTERVAL '12 hours'
    ORDER BY jrd.start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  at=% status=% msg=%',
    r.start_time, r.status, left(COALESCE(r.return_message,''), 200); END LOOP;

  -- Are the daily resolve-picks crons firing healthily (they run only 3x/day)?
  RAISE NOTICE '[D-513 §3d] resolve-picks daily cron last fires (3x/day):';
  FOR r IN
    SELECT j.jobname, max(jrd.start_time) AS last_fire,
           count(*) FILTER (WHERE jrd.start_time > NOW() - INTERVAL '24 hours') AS fires_24h
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname IN ('resolve-picks-daily','resolve-picks-cleanup','resolve-picks-nightly')
    GROUP BY j.jobname
  LOOP RAISE NOTICE '  job=% last_fire=% fires_24h=%', r.jobname, r.last_fire, r.fires_24h; END LOOP;
END $$;
