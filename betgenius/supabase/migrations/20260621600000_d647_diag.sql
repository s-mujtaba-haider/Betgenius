-- D-647 — READ-ONLY: Sonnet stub-vs-full diagnose.

-- Q1 — Stub rate per confidence tier on TODAY's MLB recommendations_cache.
-- Stub = ai_analysis contains the literal "Algorithm projection" template marker.
CREATE OR REPLACE FUNCTION public.d647_stub_rate_today()
RETURNS TABLE (
  conf_tier   TEXT,
  n_picks     BIGINT,
  n_stub      BIGINT,
  n_full      BIGINT,
  pct_stub    NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  WITH base AS (
    SELECT confidence, ai_analysis,
      CASE
        WHEN ai_analysis IS NULL THEN 'null_ai'
        WHEN ai_analysis ILIKE '%Algorithm projection%' THEN 'stub'
        ELSE 'full'
      END AS kind
    FROM public.recommendations_cache
    WHERE sport = 'mlb' AND game_date = '20260621'
  )
  SELECT
    CASE
      WHEN confidence >= 90 THEN '1_elite_>=90'
      WHEN confidence >= 80 THEN '2_strong_80-89'
      WHEN confidence >= 70 THEN '3_good_70-79'
      WHEN confidence >= 60 THEN '4_lean_60-69'
      ELSE                     '5_pass_<60'
    END AS conf_tier,
    COUNT(*),
    SUM(CASE WHEN kind = 'stub' THEN 1 ELSE 0 END),
    SUM(CASE WHEN kind = 'full' THEN 1 ELSE 0 END),
    ROUND(100.0 * SUM(CASE WHEN kind = 'stub' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*), 0), 1)
  FROM base
  GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_stub_rate_today() TO service_role;

-- Q2 — Specific examples: Spencer Horwitz + Freddie Freeman today.
CREATE OR REPLACE FUNCTION public.d647_named_picks()
RETURNS TABLE (
  player_name TEXT, prop_type TEXT, pick_side TEXT, line NUMERIC,
  confidence INT, is_stub BOOLEAN, ai_first_100 TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.player_name, r.prop_type, r.pick_side, r.line, r.confidence::INT,
    (r.ai_analysis ILIKE '%Algorithm projection%') AS is_stub,
    LEFT(r.ai_analysis, 100) AS ai_first_100
  FROM public.recommendations_cache r
  WHERE r.sport = 'mlb' AND r.game_date = '20260621'
    AND (r.player_name ILIKE '%Horwitz%' OR r.player_name ILIKE '%Freeman%')
  ORDER BY r.player_name, r.confidence DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_named_picks() TO service_role;

-- Q3 — Stub-rate within conf>=70 only. If gate is purely confidence,
-- this should be ~0%. If non-zero, something ELSE stubs high-conf picks
-- (API failure, dedup_hit, reuse-gone-wrong).
CREATE OR REPLACE FUNCTION public.d647_high_conf_stubs()
RETURNS TABLE (
  player_name TEXT, prop_type TEXT, confidence INT, market TEXT,
  ai_first_120 TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.player_name, r.prop_type, r.confidence::INT,
    r.mlb_market_type::TEXT,
    LEFT(r.ai_analysis, 120)
  FROM public.recommendations_cache r
  WHERE r.sport = 'mlb' AND r.game_date = '20260621'
    AND r.confidence >= 70
    AND r.ai_analysis ILIKE '%Algorithm projection%'
  ORDER BY r.confidence DESC, r.player_name
  LIMIT 30;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_high_conf_stubs() TO service_role;
