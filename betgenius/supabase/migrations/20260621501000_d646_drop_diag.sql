-- D-646 cleanup — drop the throwaway diagnose + fire RPCs.
DROP FUNCTION IF EXISTS public.d646_ballpark_dist();
DROP FUNCTION IF EXISTS public.d646_ballpark_picks_dist();
DROP FUNCTION IF EXISTS public.d646_arsenal_tables();
DROP FUNCTION IF EXISTS public.d646_run_form_dist();
DROP FUNCTION IF EXISTS public.d646_fire_savant();
