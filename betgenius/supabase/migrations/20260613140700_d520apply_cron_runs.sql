-- D-520-APPLY SHIP 2 §E.8 — check actual cron run history for process-games-mlb
-- so we know whether the job has been firing post-deploy (and whether new
-- picks should have shown up).
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-520-APPLY §E.8] cron.job_run_details recent process-games-mlb runs:';
  FOR r IN
    SELECT j.jobname,
           rd.start_time, rd.end_time, rd.status,
           left(coalesce(rd.return_message,''), 200) AS return_msg
    FROM cron.job_run_details rd
    JOIN cron.job j ON j.jobid = rd.jobid
    WHERE j.jobname IN ('process-games-mlb-30min','process-games-mlb','capture-closing-odds-mlb-5min')
      AND rd.start_time > now() - interval '2 hours'
    ORDER BY rd.start_time DESC LIMIT 15
  LOOP RAISE NOTICE '  %  start=%  end=%  status=%  msg=%',
    r.jobname, r.start_time, r.end_time, r.status, r.return_msg; END LOOP;
END $$;
