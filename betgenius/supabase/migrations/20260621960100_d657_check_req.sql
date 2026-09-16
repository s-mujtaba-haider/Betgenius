-- D-657 — what did request 33260 return?
CREATE OR REPLACE FUNCTION public.d657_check_req(p_id BIGINT)
RETURNS TABLE(id BIGINT, created TIMESTAMPTZ, status_code INT, error_msg TEXT, content_short TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout='15s';
  RETURN QUERY
    SELECT r.id, r.created, r.status_code::INT, substring(r.error_msg, 1, 200)::TEXT, substring(r.content, 1, 600)::TEXT
    FROM net._http_response r WHERE r.id = p_id;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_check_req(BIGINT) TO service_role;
