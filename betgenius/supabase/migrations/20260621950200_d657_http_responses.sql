-- D-657 — pull net._http_response status for snapshot-odds-writer + fetch-odds in last 3h.
-- pg_cron's job_run_details.return_message is the request_id; we look up the response.
CREATE OR REPLACE FUNCTION public.d657_http_responses(p_pattern TEXT, p_hours INT)
RETURNS TABLE(jobname TEXT, dispatched TIMESTAMPTZ, request_id BIGINT, http_status INT, error_msg TEXT, content_short TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout = '30s';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.return_message
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname ILIKE p_pattern
      AND jrd.start_time > NOW() - (p_hours || ' hours')::INTERVAL
      AND jrd.return_message IS NOT NULL
    ORDER BY jrd.start_time DESC
    LIMIT 30
  LOOP
    -- The return_message from net.http_post is the integer request_id (as text "1 row" sometimes when wrapped, or the id directly when SELECTed).
    -- Try to find a matching net._http_response within +/- 5 min of dispatch.
    DECLARE req BIGINT;
    BEGIN
      -- try direct integer parse; else find the LAST response near dispatched time
      BEGIN req := NULLIF(regexp_replace(r.return_message, '\D', '', 'g'), '')::BIGINT; EXCEPTION WHEN OTHERS THEN req := NULL; END;
      RETURN QUERY
        SELECT
          r.jobname::TEXT,
          r.start_time,
          hr.id,
          hr.status_code::INT,
          substring(hr.error_msg, 1, 80)::TEXT,
          substring(hr.content, 1, 200)::TEXT
        FROM net._http_response hr
        WHERE hr.created BETWEEN r.start_time - INTERVAL '10 sec' AND r.start_time + INTERVAL '5 min'
        ORDER BY hr.created DESC
        LIMIT 1;
    END;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_http_responses(TEXT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.d657_recent_responses(p_url_pattern TEXT, p_hours INT)
RETURNS TABLE(id BIGINT, created TIMESTAMPTZ, status_code INT, error_msg TEXT, content_short TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '30s';
  RETURN QUERY
    SELECT hr.id, hr.created, hr.status_code::INT, substring(hr.error_msg, 1, 80)::TEXT, substring(hr.content, 1, 300)::TEXT
    FROM net._http_response hr
    JOIN net.http_request_queue q ON q.id = hr.id
    WHERE hr.created > NOW() - (p_hours || ' hours')::INTERVAL
      AND q.url LIKE p_url_pattern
    ORDER BY hr.created DESC
    LIMIT 30;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_recent_responses(TEXT, INT) TO service_role;
