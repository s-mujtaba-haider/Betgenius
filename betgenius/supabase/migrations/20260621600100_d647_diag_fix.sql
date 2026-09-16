-- D-647 diag fix: recommendations_cache.game_date is YYYY-MM-DD;
-- mlb_market_type lives on pick_history, not rec_cache.

DROP FUNCTION IF EXISTS public.d647_stub_rate_today();
DROP FUNCTION IF EXISTS public.d647_named_picks();
DROP FUNCTION IF EXISTS public.d647_high_conf_stubs();

CREATE OR REPLACE FUNCTION public.d647_stub_rate_today()
RETURNS TABLE (conf_tier TEXT, n_picks BIGINT, n_stub BIGINT, n_full BIGINT, pct_stub NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  WITH base AS (
    SELECT r.confidence, r.ai_analysis,
      CASE
        WHEN r.ai_analysis IS NULL THEN 'null_ai'
        WHEN r.ai_analysis ILIKE '%Algorithm projection%' THEN 'stub'
        ELSE 'full'
      END AS kind
    FROM public.recommendations_cache r
    WHERE r.sport = 'mlb' AND r.game_date = '2026-06-21'
  )
  SELECT
    CASE
      WHEN base.confidence >= 90 THEN '1_elite_>=90'
      WHEN base.confidence >= 80 THEN '2_strong_80-89'
      WHEN base.confidence >= 70 THEN '3_good_70-79'
      WHEN base.confidence >= 60 THEN '4_lean_60-69'
      ELSE                          '5_pass_<60'
    END,
    COUNT(*),
    SUM(CASE WHEN base.kind = 'stub' THEN 1 ELSE 0 END),
    SUM(CASE WHEN base.kind = 'full' THEN 1 ELSE 0 END),
    ROUND(100.0 * SUM(CASE WHEN base.kind='stub' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1)
  FROM base GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_stub_rate_today() TO service_role;

CREATE OR REPLACE FUNCTION public.d647_named_picks()
RETURNS TABLE (player_name TEXT, prop_type TEXT, pick_side TEXT, line NUMERIC, confidence INT, is_stub BOOLEAN, ai_first_140 TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.player_name, r.prop_type, r.pick_side, r.line, r.confidence::INT,
    (r.ai_analysis ILIKE '%Algorithm projection%'), LEFT(r.ai_analysis, 140)
  FROM public.recommendations_cache r
  WHERE r.sport='mlb' AND r.game_date='2026-06-21'
    AND (r.player_name ILIKE '%Horwitz%' OR r.player_name ILIKE '%Freeman%')
  ORDER BY r.player_name, r.confidence DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_named_picks() TO service_role;

CREATE OR REPLACE FUNCTION public.d647_high_conf_stubs()
RETURNS TABLE (player_name TEXT, prop_type TEXT, confidence INT, ai_first_140 TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.player_name, r.prop_type, r.confidence::INT, LEFT(r.ai_analysis, 140)
  FROM public.recommendations_cache r
  WHERE r.sport='mlb' AND r.game_date='2026-06-21'
    AND r.confidence >= 70
    AND r.ai_analysis ILIKE '%Algorithm projection%'
  ORDER BY r.confidence DESC, r.player_name LIMIT 30;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_high_conf_stubs() TO service_role;

-- Bonus — pick_history Sonnet vs stub on resolved 7-day cohort. Confirms the
-- gate has been stable historically (not a today-specific cron failure).
CREATE OR REPLACE FUNCTION public.d647_stub_rate_7d()
RETURNS TABLE (conf_tier TEXT, n_picks BIGINT, n_stub BIGINT, n_full BIGINT, pct_stub NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.confidence,
      CASE
        WHEN ph.ai_analysis IS NULL THEN 'null_ai'
        WHEN ph.ai_analysis ILIKE '%Algorithm projection%' THEN 'stub'
        ELSE 'full'
      END AS kind
    FROM public.pick_history ph
    WHERE ph.sport='mlb' AND COALESCE(ph.is_synthetic,FALSE)=FALSE
      AND ph.created_at > NOW() - INTERVAL '7 days'
  )
  SELECT
    CASE
      WHEN base.confidence >= 90 THEN '1_elite_>=90'
      WHEN base.confidence >= 80 THEN '2_strong_80-89'
      WHEN base.confidence >= 70 THEN '3_good_70-79'
      WHEN base.confidence >= 60 THEN '4_lean_60-69'
      ELSE                          '5_pass_<60'
    END,
    COUNT(*),
    SUM(CASE WHEN base.kind='stub' THEN 1 ELSE 0 END),
    SUM(CASE WHEN base.kind='full' THEN 1 ELSE 0 END),
    ROUND(100.0 * SUM(CASE WHEN base.kind='stub' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1)
  FROM base GROUP BY 1 ORDER BY 1;
END $$;
GRANT EXECUTE ON FUNCTION public.d647_stub_rate_7d() TO service_role;
