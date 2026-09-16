-- Try SECURITY INVOKER (default) and explicit search_path. Sometimes PostgREST
-- has issues with SECURITY DEFINER + no search_path.
DROP FUNCTION IF EXISTS public.d515_props_cache_velocity();
DROP FUNCTION IF EXISTS public.d515_clv_window_counts();

CREATE OR REPLACE FUNCTION public.d515_props_cache_velocity()
RETURNS INTEGER LANGUAGE sql STABLE
SET search_path = public AS $$
  SELECT count(*)::INTEGER FROM public.props_cache
   WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '90 minutes';
$$;

CREATE OR REPLACE FUNCTION public.d515_clv_window_counts()
RETURNS TABLE(games_started INTEGER, stamps INTEGER)
LANGUAGE sql STABLE
SET search_path = public AS $$
  SELECT
    (SELECT count(*)::INTEGER FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_time::timestamptz BETWEEN NOW() - INTERVAL '6 hours' AND NOW()),
    (SELECT count(*)::INTEGER FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND closing_captured_at > NOW() - INTERVAL '2 hours');
$$;

GRANT EXECUTE ON FUNCTION public.d515_props_cache_velocity() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.d515_clv_window_counts() TO PUBLIC;

-- Force PostgREST to reload its schema cache so the new RPCs are visible.
NOTIFY pgrst, 'reload schema';
