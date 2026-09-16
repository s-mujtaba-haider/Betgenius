-- D-642 — diagnose RPCs. Throwaway helpers used to capture the actual
-- error / plan that the browser hits on pick_history. Dropped after
-- diagnosis via 20260621101000.

CREATE OR REPLACE FUNCTION public.d642_pick_history_policies()
RETURNS TABLE (
  schemaname TEXT,
  tablename  TEXT,
  policyname TEXT,
  permissive TEXT,
  roles      TEXT[],
  cmd        TEXT,
  qual       TEXT,
  with_check TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  SELECT p.schemaname::TEXT, p.tablename::TEXT, p.policyname::TEXT,
         p.permissive::TEXT, p.roles::TEXT[], p.cmd::TEXT,
         p.qual::TEXT, p.with_check::TEXT
  FROM pg_policies p
  WHERE p.tablename IN ('pick_history','cache_odds_snapshots','recommendations_cache','bets','props_cache','cache_mlb_game_scoreboard')
  ORDER BY p.tablename, p.policyname;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_pick_history_policies() TO service_role;

CREATE OR REPLACE FUNCTION public.d642_pick_history_indexes()
RETURNS TABLE (
  schemaname TEXT,
  tablename  TEXT,
  indexname  TEXT,
  indexdef   TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  SELECT i.schemaname::TEXT, i.tablename::TEXT, i.indexname::TEXT, i.indexdef::TEXT
  FROM pg_indexes i
  WHERE i.tablename = 'pick_history';
END $$;
GRANT EXECUTE ON FUNCTION public.d642_pick_history_indexes() TO service_role;

CREATE OR REPLACE FUNCTION public.d642_perf_query_plan_as_auth()
RETURNS TABLE (line TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  -- Switch to authenticated role like PostgREST does for an authed JWT.
  SET LOCAL ROLE authenticated;
  RETURN QUERY
  EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT TEXT)
  SELECT id, game_date, hit, odds, prop_type, pick_side
  FROM public.pick_history
  WHERE sport = 'mlb'
    AND recommendation_shown = TRUE
    AND voided = FALSE
    AND hit IS NOT NULL
  ORDER BY game_date ASC, id ASC
  LIMIT 1000;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_perf_query_plan_as_auth() TO service_role;

-- Try the same query as anon role.
CREATE OR REPLACE FUNCTION public.d642_perf_query_plan_as_anon()
RETURNS TABLE (line TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  SET LOCAL ROLE anon;
  RETURN QUERY
  EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT TEXT)
  SELECT id, game_date, hit, odds, prop_type, pick_side
  FROM public.pick_history
  WHERE sport = 'mlb'
    AND recommendation_shown = TRUE
    AND voided = FALSE
    AND hit IS NOT NULL
  ORDER BY game_date ASC, id ASC
  LIMIT 1000;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_perf_query_plan_as_anon() TO service_role;

-- Sanity-check column types.
CREATE OR REPLACE FUNCTION public.d642_pick_history_columns()
RETURNS TABLE (col_name TEXT, col_type TEXT, is_nullable TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT column_name::TEXT, data_type::TEXT, is_nullable::TEXT
  FROM information_schema.columns
  WHERE table_name = 'pick_history' AND table_schema='public'
    AND column_name IN ('sport','recommendation_shown','voided','hit','game_date','id','breakdown','ai_analysis');
END $$;
GRANT EXECUTE ON FUNCTION public.d642_pick_history_columns() TO service_role;
