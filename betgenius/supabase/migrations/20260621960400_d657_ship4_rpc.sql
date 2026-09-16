-- D-657 SHIP 4 — RPC for the new system-health 546-burn check.
CREATE OR REPLACE FUNCTION public.d657_worker_resource_limit_count()
RETURNS TABLE(window_minutes INT, n_546 INT, n_5xx INT, recent_sample TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_window INT := 30;
BEGIN
  SET LOCAL statement_timeout = '15s';
  RETURN QUERY
    SELECT v_window,
           SUM(CASE WHEN r.status_code = 546 THEN 1 ELSE 0 END)::INT,
           SUM(CASE WHEN r.status_code >= 500 THEN 1 ELSE 0 END)::INT,
           (
             SELECT format('%s status=%s %s', r2.created::TEXT, r2.status_code, substring(r2.content, 1, 80))
             FROM net._http_response r2
             WHERE r2.created > NOW() - (v_window || ' minutes')::INTERVAL
               AND r2.status_code >= 500
             ORDER BY r2.created DESC
             LIMIT 1
           )::TEXT
    FROM net._http_response r
    WHERE r.created > NOW() - (v_window || ' minutes')::INTERVAL;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_worker_resource_limit_count() TO service_role;
