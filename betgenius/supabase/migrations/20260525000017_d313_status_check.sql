-- D-313 status check — read-only. Logs cron run details + net._http_response.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE '[STATUS Q2] last 3 cron firings (orchestrator-execute):';
  FOR v_row IN
    SELECT j.jobname,
           d.start_time::text AS start_time,
           d.status::text     AS pg_cron_status,
           ROUND(EXTRACT(EPOCH FROM (d.end_time - d.start_time))::numeric, 3) AS dur_s
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'orchestrator-execute'
    ORDER BY d.start_time DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '  % | start=% | %=% | dur=%s', v_row.jobname, v_row.start_time, 'pg_cron', v_row.pg_cron_status, v_row.dur_s;
  END LOOP;

  RAISE NOTICE '[STATUS Q3] last 3 net._http_response rows:';
  FOR v_row IN
    SELECT created::text AS created, status_code, COALESCE(error_msg, '(none)') AS error_msg
    FROM net._http_response
    ORDER BY created DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '  % | http=% | err=%', v_row.created, v_row.status_code, v_row.error_msg;
  END LOOP;
END $$;
