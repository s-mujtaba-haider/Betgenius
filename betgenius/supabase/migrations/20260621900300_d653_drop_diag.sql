-- D-653 cleanup — drop the throwaway diagnose RPC used for HTTP response inspection.
DROP FUNCTION IF EXISTS public.d653_check_response(BIGINT);
