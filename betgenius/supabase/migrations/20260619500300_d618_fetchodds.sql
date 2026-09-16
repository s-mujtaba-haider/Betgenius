DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '[J] props_cache columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='props_cache' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[K] fetch-odds-mlb activity today (cron_progress + error_log):';
  FOR r IN
    SELECT created_at, error_type, error_message, LEFT(COALESCE(context::text,''), 200) AS detail
      FROM public.error_log
     WHERE (function_name LIKE 'fetch-odds%' OR error_message LIKE '%fetch_odds%' OR error_message LIKE '%fetch-odds%')
       AND created_at >= now() - interval '6 hours'
     ORDER BY created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  at=% type=% msg=% detail=%', r.created_at, r.error_type, r.error_message, r.detail;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[M] cron.job entries for mlb fetch-odds:';
  FOR r IN
    SELECT jobid, schedule, jobname, active
      FROM cron.job
     WHERE jobname ILIKE '%fetch%odds%mlb%' OR command ILIKE '%fetch-odds-mlb%'
     LIMIT 6
  LOOP
    RAISE NOTICE '  jobid=% sched=% name=% active=%', r.jobid, r.schedule, r.jobname, r.active;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[N] cron.job_run_details for fetch-odds-mlb in last 4h:';
  FOR r IN
    SELECT runid, jobid, start_time, end_time, status, LEFT(COALESCE(return_message,''),120) AS msg
      FROM cron.job_run_details
     WHERE start_time >= now() - interval '4 hours'
       AND (jobid IN (SELECT jobid FROM cron.job WHERE jobname ILIKE '%fetch%odds%mlb%' OR command ILIKE '%fetch-odds-mlb%'))
     ORDER BY start_time DESC LIMIT 12
  LOOP
    RAISE NOTICE '  runid=% start=% end=% status=% msg=%', r.runid, r.start_time, r.end_time, r.status, r.msg;
  END LOOP;
END $$;
