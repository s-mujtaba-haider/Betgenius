-- D-313 — find the auth pattern actually used by working crons.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE '[D-313 working] inspecting commands of recently-fired succeeded crons:';
  FOR v_row IN
    SELECT j.jobname, j.command
    FROM cron.job j
    WHERE j.active = true
      AND EXISTS (
        SELECT 1 FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.status = 'succeeded'
          AND d.start_time > NOW() - INTERVAL '4 hours'
      )
    ORDER BY j.jobname
    LIMIT 30
  LOOP
    RAISE NOTICE '====== % ======', v_row.jobname;
    RAISE NOTICE '%', substring(v_row.command FROM 1 FOR 700);
  END LOOP;
END $$;
