-- D-648 cleanup — drop the throwaway diagnose RPCs.
DROP FUNCTION IF EXISTS public.d648_q1_game_factor_pop();
DROP FUNCTION IF EXISTS public.d648_q2_factors_per_pick();
DROP FUNCTION IF EXISTS public.d648_q3_game_weights();
DROP FUNCTION IF EXISTS public.d648_q4_offense_inputs();
