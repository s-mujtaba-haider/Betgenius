-- D-643 net response reader — use actual column names from net._http_response.
DROP FUNCTION IF EXISTS public.d643_net_response(BIGINT);
CREATE OR REPLACE FUNCTION public.d643_net_response(p_request_id BIGINT)
RETURNS TABLE (status INT, content TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp, net
AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
  SELECT r.status_code::INT, LEFT(r.content::TEXT, 4000)
  FROM net._http_response r WHERE r.id = p_request_id;
END $$;
GRANT EXECUTE ON FUNCTION public.d643_net_response(BIGINT) TO service_role;
