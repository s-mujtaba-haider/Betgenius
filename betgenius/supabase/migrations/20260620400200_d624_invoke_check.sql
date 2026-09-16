DO $$ DECLARE r RECORD; BEGIN
  -- Find system-health cron schedule
  RAISE NOTICE 'cron.job entries for system-health:';
  FOR r IN
    SELECT jobid, schedule, jobname, LEFT(command, 200) AS cmd, active
      FROM cron.job
     WHERE jobname ILIKE '%system%health%' OR command ILIKE '%system-health%'
  LOOP
    RAISE NOTICE '  jobid=% sched=% name=% active=%', r.jobid, r.schedule, r.jobname, r.active;
    RAISE NOTICE '    cmd=%', r.cmd;
  END LOOP;

  -- Current state of health_status (most recent for each check)
  RAISE NOTICE '';
  RAISE NOTICE 'Current health_status (latest per check_name):';
  FOR r IN
    SELECT DISTINCT ON (check_name) check_name, status, LEFT(detail, 200) AS detail, created_at
      FROM public.health_status
     ORDER BY check_name, created_at DESC
  LOOP
    RAISE NOTICE '  % : % (% UTC) — %', r.check_name, r.status, r.created_at, r.detail;
  END LOOP;
END $$;
