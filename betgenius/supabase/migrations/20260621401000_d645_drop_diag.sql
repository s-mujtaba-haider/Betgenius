-- D-645 cleanup — drop the throwaway diagnose RPCs.
DROP FUNCTION IF EXISTS public.d645_q1_factor_population();
DROP FUNCTION IF EXISTS public.d645_q2_factors_per_pick();
DROP FUNCTION IF EXISTS public.d645_q3_runs_elite_breakdown();
