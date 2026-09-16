-- D-646 — READ-ONLY probes for the 3 starved RS factors.

-- §1 — Ballpark runs-factor distribution (all parks, current data).
CREATE OR REPLACE FUNCTION public.d646_ballpark_dist()
RETURNS TABLE (bucket TEXT, n_parks INT, runs_factor_min NUMERIC, runs_factor_max NUMERIC, runs_factor_avg NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  WITH parks AS (
    SELECT venue, runs_factor::numeric AS rf
    FROM public.cache_ballpark_factors
    WHERE runs_factor IS NOT NULL
  )
  SELECT
    CASE
      WHEN rf >= 1.10 THEN '1_>=1.10 fires +4'
      WHEN rf >= 1.05 THEN '2_>=1.05 fires +2'
      WHEN rf >= 0.95 THEN '3_dead_zone'
      WHEN rf >= 0.90 THEN '4_<=0.95 fires -2'
      ELSE                  '5_<=0.90 fires -4'
    END AS bucket,
    COUNT(*)::INT,
    ROUND(MIN(rf)::NUMERIC, 4),
    ROUND(MAX(rf)::NUMERIC, 4),
    ROUND(AVG(rf)::NUMERIC, 4)
  FROM parks
  GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d646_ballpark_dist() TO service_role;

-- §1b — same distribution but for the parks actually USED by RS picks last 21d.
-- (cache_ballpark_factors has every park, but only some host RS picks.)
CREATE OR REPLACE FUNCTION public.d646_ballpark_picks_dist()
RETURNS TABLE (bucket TEXT, n_picks BIGINT, pct NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';
  RETURN QUERY
  WITH p AS (
    SELECT COALESCE((breakdown->>'park_runs_factor')::numeric, NULL) AS rf
    FROM public.pick_history
    WHERE mlb_market_type = 'batter_runs_scored'
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > NOW() - INTERVAL '21 days'
      AND breakdown IS NOT NULL
      AND breakdown ? 'park_runs_factor'
  )
  SELECT
    CASE
      WHEN rf IS NULL  THEN '0_null'
      WHEN rf >= 1.10  THEN '1_>=1.10 fires +4'
      WHEN rf >= 1.05  THEN '2_>=1.05 fires +2'
      WHEN rf > 0.95   THEN '3_dead_zone (no fire)'
      WHEN rf >= 0.90  THEN '4_<=0.95 fires -2'
      ELSE                  '5_<=0.90 fires -4'
    END,
    COUNT(*),
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)
  FROM p
  GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d646_ballpark_picks_dist() TO service_role;

-- §2 — opp_pitcher_arsenal coverage trace.
--   (a) How many distinct opp_pitcher_ids appear on RS picks last 21d?
--   (b) Of those, how many have a row in cache_pitcher_pitch_arsenal
--       (or whatever the cache table is)?
--   (c) What's the gate?
CREATE OR REPLACE FUNCTION public.d646_arsenal_tables()
RETURNS TABLE (table_name TEXT, n_rows BIGINT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  SELECT t.tablename::TEXT, COALESCE((
    SELECT n_live_tup FROM pg_stat_user_tables p
    WHERE p.schemaname='public' AND p.relname=t.tablename
  ), 0)
  FROM pg_tables t
  WHERE t.schemaname='public'
    AND (t.tablename ILIKE '%arsenal%' OR t.tablename ILIKE '%pitch_type%' OR t.tablename ILIKE '%pitcher%pitch%' OR t.tablename ILIKE '%put_away%')
  ORDER BY t.tablename;
END $$;
GRANT EXECUTE ON FUNCTION public.d646_arsenal_tables() TO service_role;

-- §3 — recent_run_form gate trace.
-- Compute recentR - seasonR diff for live RS picks (from breakdown), see distribution.
CREATE OR REPLACE FUNCTION public.d646_run_form_dist()
RETURNS TABLE (bucket TEXT, n_picks BIGINT, pct NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';
  RETURN QUERY
  WITH p AS (
    SELECT
      COALESCE((breakdown->>'recent_r_per_game')::numeric, NULL) AS recent_r,
      COALESCE((breakdown->>'season_r_per_game')::numeric, NULL) AS season_r,
      COALESCE((breakdown->>'season_games')::numeric, NULL) AS season_games
    FROM public.pick_history
    WHERE mlb_market_type = 'batter_runs_scored'
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > NOW() - INTERVAL '21 days'
      AND breakdown IS NOT NULL
  )
  SELECT
    CASE
      WHEN recent_r IS NULL OR season_r IS NULL OR season_r = 0 THEN '0_input_null_or_no_season'
      WHEN season_games IS NOT NULL AND season_games < 5  THEN '1_thin_sample'
      WHEN ABS(recent_r - season_r) >= 0.30 THEN '5_>=0.30 fires +-6'
      WHEN ABS(recent_r - season_r) >= 0.15 THEN '4_>=0.15 fires +-3'
      WHEN ABS(recent_r - season_r) >= 0.10 THEN '3_0.10..0.15 dead'
      WHEN ABS(recent_r - season_r) >= 0.05 THEN '2_0.05..0.10 dead'
      ELSE                                       '1_<0.05 truly neutral'
    END,
    COUNT(*),
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)
  FROM p
  GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d646_run_form_dist() TO service_role;
