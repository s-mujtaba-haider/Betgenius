-- D-642 cleanup — drop the throwaway diagnose RPCs.
-- Rollback: re-apply 20260621100000 + 20260621100200.

DROP FUNCTION IF EXISTS public.d642_pick_history_policies();
DROP FUNCTION IF EXISTS public.d642_pick_history_indexes();
DROP FUNCTION IF EXISTS public.d642_pick_history_columns();
DROP FUNCTION IF EXISTS public.d642_perf_query_plan_as_auth();
DROP FUNCTION IF EXISTS public.d642_perf_query_plan_as_anon();
DROP FUNCTION IF EXISTS public.d642_slow_queries();
DROP FUNCTION IF EXISTS public.d642_perf_explain_simple();
DROP FUNCTION IF EXISTS public.d642_active_queries();
