-- PostgREST hides function names starting with underscore (treated as private).
-- Rename without the prefix so /rest/v1/rpc/<name> resolves.
DROP FUNCTION IF EXISTS public._d515_props_cache_velocity();
DROP FUNCTION IF EXISTS public._d515_clv_window_counts();

CREATE OR REPLACE FUNCTION public.d515_props_cache_velocity()
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT count(*)::INTEGER FROM public.props_cache
   WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '90 minutes';
$$;

CREATE OR REPLACE FUNCTION public.d515_clv_window_counts()
RETURNS TABLE(games_started INTEGER, stamps INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    (SELECT count(*)::INTEGER FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_time::timestamptz BETWEEN NOW() - INTERVAL '6 hours' AND NOW()) AS games_started,
    (SELECT count(*)::INTEGER FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND closing_captured_at > NOW() - INTERVAL '2 hours') AS stamps;
$$;

GRANT EXECUTE ON FUNCTION public.d515_props_cache_velocity() TO service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.d515_clv_window_counts() TO service_role, authenticated, anon;

DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '[D-515 RPC v2] props=%', public.d515_props_cache_velocity();
  FOR r IN SELECT * FROM public.d515_clv_window_counts()
  LOOP RAISE NOTICE '[D-515 RPC v2] clv: games=% stamps=%', r.games_started, r.stamps; END LOOP;
END $$;
