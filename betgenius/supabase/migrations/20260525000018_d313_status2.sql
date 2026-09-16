-- Read-only status check #2. Logs last 3 cron firings.
DO $$
DECLARE v_row RECORD;
BEGIN
  RAISE NOTICE '[STATUS2 Q4] last 3 cron firings (orchestrator-execute):';
  FOR v_row IN
    SELECT d.start_time::text AS start_time, d.status::text AS pg_cron_status
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'orchestrator-execute'
    ORDER BY d.start_time DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '  start=% | pg_cron=%', v_row.start_time, v_row.pg_cron_status;
  END LOOP;
END $$;
