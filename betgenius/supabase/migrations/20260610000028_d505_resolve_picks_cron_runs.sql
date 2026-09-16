DO $$
DECLARE r RECORD;
BEGIN
  -- cron job_run_details for the 3 resolve-picks jobs
  RAISE NOTICE '[D-505] cron.job_run_details for jobids 1, 2, 3 (resolve-picks crons) — last 10 each:';
  FOR r IN
    SELECT j.jobname, jr.jobid, jr.start_time, jr.end_time, jr.status,
           substring(jr.return_message, 1, 200) AS msg
    FROM cron.job_run_details jr
    JOIN cron.job j ON j.jobid = jr.jobid
    WHERE jr.jobid IN (1,2,3)
    ORDER BY jr.start_time DESC LIMIT 30
  LOOP
    RAISE NOTICE '  job=% jobid=% start=% status=% msg=%',
      r.jobname, r.jobid, r.start_time, r.status, COALESCE(r.msg, '<null>');
  END LOOP;

  -- Also any resolve-picks-related entries in run_log via LIKE search
  RAISE NOTICE '[D-505] run_log function_name samples (recent unique):';
  FOR r IN
    SELECT function_name, count(*) AS n, max(created_at) AS most_recent
    FROM public.run_log
    WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY function_name ORDER BY most_recent DESC LIMIT 30
  LOOP
    RAISE NOTICE '  fn=% n=% most_recent=%', r.function_name, r.n, r.most_recent;
  END LOOP;
END $$;
