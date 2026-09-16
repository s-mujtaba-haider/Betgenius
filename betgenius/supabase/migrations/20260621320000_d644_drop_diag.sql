-- D-644 cleanup — drop the throwaway diagnose RPCs.
DROP FUNCTION IF EXISTS public.d644_explain_perf_query(UUID);
DROP FUNCTION IF EXISTS public.d644_time_perf_query(UUID);
DROP FUNCTION IF EXISTS public.d644_ph_join_indexes();
DROP FUNCTION IF EXISTS public.d644_explain_plan_only(UUID);
