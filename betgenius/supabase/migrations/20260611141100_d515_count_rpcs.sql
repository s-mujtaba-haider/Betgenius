-- D-515 SHIP 2 — SQL RPCs for the 2 multi-filter datetime checks where
-- PostgREST HTTP GET kept failing (props_cache, clv_stamp). Health monitor
-- calls these via POST /rest/v1/rpc/<name>. Guaranteed to work since the
-- counting happens server-side in SQL.

CREATE OR REPLACE FUNCTION public._d515_props_cache_velocity()
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT count(*)::INTEGER FROM public.props_cache
   WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '90 minutes';
$$;

CREATE OR REPLACE FUNCTION public._d515_clv_window_counts()
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

GRANT EXECUTE ON FUNCTION public._d515_props_cache_velocity() TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public._d515_clv_window_counts() TO service_role, authenticated;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-515 RPC] _d515_props_cache_velocity smoke = %', public._d515_props_cache_velocity();
  FOR r IN SELECT * FROM public._d515_clv_window_counts()
  LOOP RAISE NOTICE '[D-515 RPC] _d515_clv_window_counts: games=% stamps=%', r.games_started, r.stamps; END LOOP;
END $$;
