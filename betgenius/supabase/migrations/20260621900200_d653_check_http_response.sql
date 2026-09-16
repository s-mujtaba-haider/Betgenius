-- D-653 — check the http_response for our fired request id=32878 to debug
CREATE OR REPLACE FUNCTION public.d653_check_response(p_req_id BIGINT)
RETURNS TABLE(status_code INT, content_short TEXT, error_msg TEXT, created TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '30s';
  RETURN QUERY
    SELECT
      r.status_code::INT,
      LEFT(COALESCE(r.content, ''), 600),
      r.error_msg,
      r.created
    FROM net._http_response r
    WHERE r.id = p_req_id;
END $$;
GRANT EXECUTE ON FUNCTION public.d653_check_response(BIGINT) TO service_role;
