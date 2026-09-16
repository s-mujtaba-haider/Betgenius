-- D-647 cleanup — drop the throwaway stub-rate RPCs.
DROP FUNCTION IF EXISTS public.d647_stub_rate_today();
DROP FUNCTION IF EXISTS public.d647_named_picks();
DROP FUNCTION IF EXISTS public.d647_high_conf_stubs();
DROP FUNCTION IF EXISTS public.d647_stub_rate_7d();
