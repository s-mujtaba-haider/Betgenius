-- D-714 READ-ONLY morning check. NOTICE-only inspection.
SET statement_timeout = '60s';

DO $$
DECLARE rec record; n int;
BEGIN
  RAISE NOTICE '=== resolve_backlog_run_log (last 20) ===';
  BEGIN
    FOR rec IN
      SELECT * FROM resolve_backlog_run_log ORDER BY started_at DESC LIMIT 20
    LOOP
      RAISE NOTICE '  %', row_to_json(rec);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  err: %', SQLERRM;
  END;

  RAISE NOTICE '=== pg_net last 24h: counts by status_code ===';
  FOR rec IN
    SELECT status_code, count(*) AS n
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '24 hours'
    GROUP BY status_code ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=% count=%', COALESCE(rec.status_code::text,'pending'), rec.n;
  END LOOP;

  RAISE NOTICE '=== pg_net overnight 03:00-13:00 UTC (likely overnight idle window) ===';
  SELECT count(*) INTO n FROM net._http_response
   WHERE created > NOW()::date + INTERVAL '3 hours' AND created < NOW()::date + INTERVAL '13 hours';
  RAISE NOTICE '  total overnight pg_net calls: %', n;
  FOR rec IN
    SELECT status_code, count(*) AS c FROM net._http_response
    WHERE created > NOW()::date + INTERVAL '3 hours' AND created < NOW()::date + INTERVAL '13 hours'
    GROUP BY status_code ORDER BY c DESC
  LOOP
    RAISE NOTICE '    status=% count=%', COALESCE(rec.status_code::text,'pending'), rec.c;
  END LOOP;

  RAISE NOTICE '=== Active crons relevant to resolver ===';
  FOR rec IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job
    WHERE jobname IN ('d692-drain-resolver-backlog','d694-recent-resolver',
                      'resolve-picks-daily','resolve-picks-nightly','resolve-picks-cleanup',
                      'process-games-mlb-30min','register-game-schedule-hourly')
    ORDER BY jobname
  LOOP
    RAISE NOTICE '  jobid=% jobname=% schedule=% active=%', rec.jobid, rec.jobname, rec.schedule, rec.active;
  END LOOP;

  RAISE NOTICE '=== cron.job_run_details — recent runs of resolver crons ===';
  BEGIN
    FOR rec IN
      SELECT j.jobname, r.status, r.start_time, r.end_time, r.return_message
      FROM cron.job_run_details r
      JOIN cron.job j ON j.jobid = r.jobid
      WHERE j.jobname IN ('d692-drain-resolver-backlog','d694-recent-resolver',
                          'resolve-picks-daily','resolve-picks-nightly','resolve-picks-cleanup')
        AND r.start_time > NOW() - INTERVAL '24 hours'
      ORDER BY r.start_time DESC LIMIT 30
    LOOP
      RAISE NOTICE '  % [%] %', rec.jobname, rec.status, rec.start_time;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  err: %', SQLERRM;
  END;

  -- unresolved breakdown by age
  RAISE NOTICE '=== Unresolved pick_history by age bucket ===';
  FOR rec IN
    SELECT
      CASE
        WHEN created_at > NOW() - INTERVAL '1 day' THEN '0-1 day'
        WHEN created_at > NOW() - INTERVAL '3 days' THEN '1-3 days'
        WHEN created_at > NOW() - INTERVAL '7 days' THEN '3-7 days'
        WHEN created_at > NOW() - INTERVAL '14 days' THEN '7-14 days'
        ELSE '14+ days'
      END AS bucket,
      count(*) AS n
    FROM pick_history WHERE hit IS NULL
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  %  n=%', rec.bucket, rec.n;
  END LOOP;
END $$;
