-- D-657 — raw recent net._http_response rows (no join) so we can see what came back
CREATE OR REPLACE FUNCTION public.d657_raw_responses(p_hours INT)
RETURNS TABLE(id BIGINT, created TIMESTAMPTZ, status_code INT, error_msg TEXT, content_short TEXT, content_type TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '30s';
  RETURN QUERY
    SELECT hr.id, hr.created, hr.status_code::INT,
           substring(hr.error_msg, 1, 80)::TEXT,
           substring(hr.content, 1, 250)::TEXT,
           hr.content_type::TEXT
    FROM net._http_response hr
    WHERE hr.created > NOW() - (p_hours || ' hours')::INTERVAL
    ORDER BY hr.created DESC
    LIMIT 50;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_raw_responses(INT) TO service_role;

-- Also dump cron job_run_details for cron that calls SQL function directly (not http_post)
CREATE OR REPLACE FUNCTION public.d657_capture_closing_runs(p_hours INT)
RETURNS TABLE(start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, status TEXT, return_message TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
    SELECT jrd.start_time, jrd.end_time, jrd.status::TEXT, substring(jrd.return_message, 1, 200)::TEXT
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname = 'capture-closing-odds-mlb-5min'
      AND jrd.start_time > NOW() - (p_hours || ' hours')::INTERVAL
    ORDER BY jrd.start_time DESC
    LIMIT 30;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_capture_closing_runs(INT) TO service_role;
