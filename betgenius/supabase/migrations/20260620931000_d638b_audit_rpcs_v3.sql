-- D-638b v3 — correct filter column.
-- ────────────────────────────────────────────────────────────────────
-- v1/v2 used pick_history.prop_type which carries the BOOK-FACING name
-- ('home_runs', 'rbis', 'totals', ...). The 6 markets in D-638's
-- semantic list ('batter_hr', 'batter_rbis', ..., 'game_total') are
-- mlb_market_type values. Probe of pick_history confirms the mapping:
--   home_runs        → batter_hr
--   rbis             → batter_rbis
--   runs_scored      → batter_runs_scored
--   strikeouts       → batter_strikeouts  (only ~2 resolved real picks in 90d)
--   pitcher_outs     → pitcher_outs       (only ~8)
--   totals           → game_total
-- v3 swaps the filter to mlb_market_type and returns the mlb_market_type
-- as the row key so the result table matches the semantic naming in
-- the doc. No other changes.

DROP FUNCTION IF EXISTS public.d638_q1();
DROP FUNCTION IF EXISTS public.d638_q2();
DROP FUNCTION IF EXISTS public.d638_q3();
DROP FUNCTION IF EXISTS public.d638_q4();

-- ─── Q1 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.d638_q1()
RETURNS TABLE (
  market                TEXT,
  n                     BIGINT,
  actual_wr_pct         NUMERIC,
  avg_break_even_pct    NUMERIC,
  real_ev_pp            NUMERIC,
  verdict               TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT
      ph.mlb_market_type AS market,
      ph.hit,
      ph.odds,
      CASE
        WHEN ph.odds > 0 THEN 100.0 / (ph.odds + 100.0)
        WHEN ph.odds < 0 THEN (-ph.odds)::numeric / ((-ph.odds) + 100.0)
        ELSE NULL
      END AS break_even
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN (
      'batter_hr','batter_rbis','batter_runs_scored',
      'batter_strikeouts','pitcher_outs','game_total'
    )
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.hit IS NOT NULL
      AND ph.odds IS NOT NULL
      AND ph.created_at > NOW() - INTERVAL '90 days'
  )
  SELECT
    base.market,
    COUNT(*) AS n,
    ROUND(100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END), 2) AS actual_wr_pct,
    ROUND(100.0 * AVG(base.break_even), 2) AS avg_break_even_pct,
    ROUND(100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END)
          - 100.0 * AVG(base.break_even), 2) AS real_ev_pp,
    CASE
      WHEN COUNT(*) < 30 THEN 'INSUFFICIENT_SAMPLE'
      WHEN 100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END)
           - 100.0 * AVG(base.break_even) <= -10 THEN 'SEVERELY_NEGATIVE_EV'
      WHEN 100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END)
           - 100.0 * AVG(base.break_even) <= -3  THEN 'NEGATIVE_EV'
      WHEN 100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END)
           - 100.0 * AVG(base.break_even) <= 0   THEN 'BREAK_EVEN_OR_NEAR'
      WHEN 100.0 * AVG(CASE WHEN base.hit THEN 1.0 ELSE 0.0 END)
           - 100.0 * AVG(base.break_even) <= 5   THEN 'POSITIVE_EV_MILD'
      ELSE 'POSITIVE_EV_STRONG'
    END AS verdict
  FROM base
  GROUP BY base.market
  ORDER BY real_ev_pp ASC NULLS LAST;
END $$;
GRANT EXECUTE ON FUNCTION public.d638_q1() TO service_role;

-- ─── Q2 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.d638_q2()
RETURNS TABLE (
  market              TEXT,
  factor_name         TEXT,
  n_total             BIGINT,
  n_present           BIGINT,
  n_null_value        BIGINT,
  n_zero_value        BIGINT,
  n_active            BIGINT,
  pct_present         NUMERIC,
  pct_active          NUMERIC,
  coverage_verdict    TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.id, ph.mlb_market_type AS market, ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN (
      'batter_hr','batter_rbis','batter_runs_scored',
      'batter_strikeouts','pitcher_outs','game_total'
    )
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '14 days'
      AND ph.breakdown IS NOT NULL
  ),
  totals AS (
    SELECT base.market, COUNT(*) AS n_total FROM base GROUP BY base.market
  ),
  keys AS (
    SELECT b.market, kv.key, kv.value
    FROM base b, LATERAL jsonb_each(b.breakdown) AS kv
  ),
  agg AS (
    SELECT
      k.market,
      k.key AS factor_name,
      COUNT(*) AS n_present,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'null' THEN 1 ELSE 0 END) AS n_null_value,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'number'
               AND (k.value)::text::numeric = 0 THEN 1 ELSE 0 END) AS n_zero_value,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active
    FROM keys k
    GROUP BY k.market, k.key
  )
  SELECT
    a.market,
    a.factor_name,
    t.n_total,
    a.n_present,
    a.n_null_value,
    a.n_zero_value,
    a.n_active,
    ROUND(100.0 * a.n_present / NULLIF(t.n_total, 0), 1) AS pct_present,
    ROUND(100.0 * a.n_active  / NULLIF(t.n_total, 0), 1) AS pct_active,
    CASE
      WHEN 100.0 * a.n_active / NULLIF(t.n_total, 0) <  1   THEN 'DEAD'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total, 0) <  5   THEN 'NEAR_DEAD'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total, 0) < 25   THEN 'LOW_COVERAGE'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total, 0) < 60   THEN 'PARTIAL'
      ELSE 'HEALTHY'
    END AS coverage_verdict
  FROM agg a JOIN totals t USING (market)
  WHERE a.factor_name LIKE 'score\_%' ESCAPE '\'
     OR a.factor_name LIKE 'fraw\_%' ESCAPE '\'
     OR a.factor_name IN (
       'last5_hit_rate_pct','last10_hit_rate_pct','season_hit_rate_pct',
       'lineup_spot','pitcher_hand_for_split','brl_pa','xslg_diff','xba',
       'avg_hit_speed','weather_temp_f','weather_wind_mph','park_runs_factor'
     )
  ORDER BY a.market, pct_active ASC, a.factor_name;
END $$;
GRANT EXECUTE ON FUNCTION public.d638_q2() TO service_role;

-- ─── Q3 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.d638_q3()
RETURNS TABLE (
  factor_name         TEXT,
  n_markets_using     BIGINT,
  n_markets_broken    BIGINT,
  broken_markets      TEXT,
  avg_pct_active      NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.id, ph.mlb_market_type AS market, ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN (
      'batter_hr','batter_rbis','batter_runs_scored',
      'batter_strikeouts','pitcher_outs','game_total'
    )
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '14 days'
      AND ph.breakdown IS NOT NULL
  ),
  totals AS (
    SELECT base.market, COUNT(*) AS n_total FROM base GROUP BY base.market
  ),
  keys AS (
    SELECT b.market, kv.key, kv.value
    FROM base b, LATERAL jsonb_each(b.breakdown) AS kv
  ),
  per_factor AS (
    SELECT
      k.market, k.key AS factor_name, t.n_total,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active
    FROM keys k JOIN totals t USING (market)
    GROUP BY k.market, k.key, t.n_total
  ),
  flagged AS (
    SELECT
      per_factor.factor_name,
      per_factor.market,
      ROUND(100.0 * per_factor.n_active / NULLIF(per_factor.n_total, 0), 1) AS pct_active,
      CASE WHEN 100.0 * per_factor.n_active / NULLIF(per_factor.n_total, 0) < 5
        THEN 1 ELSE 0 END AS is_broken
    FROM per_factor
    WHERE per_factor.factor_name LIKE 'score\_%' ESCAPE '\'
       OR per_factor.factor_name LIKE 'fraw\_%' ESCAPE '\'
       OR per_factor.factor_name IN (
         'lineup_spot','pitcher_hand_for_split','brl_pa','xslg_diff','xba',
         'avg_hit_speed','weather_temp_f','weather_wind_mph','park_runs_factor'
       )
  )
  SELECT
    flagged.factor_name,
    COUNT(*) AS n_markets_using,
    SUM(flagged.is_broken) AS n_markets_broken,
    STRING_AGG(flagged.market, ', ' ORDER BY flagged.market)
      FILTER (WHERE flagged.is_broken = 1) AS broken_markets,
    ROUND(AVG(flagged.pct_active), 1) AS avg_pct_active
  FROM flagged
  GROUP BY flagged.factor_name
  HAVING SUM(flagged.is_broken) >= 2
  ORDER BY n_markets_broken DESC, n_markets_using DESC, flagged.factor_name;
END $$;
GRANT EXECUTE ON FUNCTION public.d638_q3() TO service_role;

-- ─── Q4 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.d638_q4()
RETURNS TABLE (
  market                            TEXT,
  cohort                            TEXT,
  n                                 BIGINT,
  pct_score_weather_temp            NUMERIC,
  pct_score_weather_wind            NUMERIC,
  pct_score_wind_direction_hr       NUMERIC,
  pct_score_batter_barrel_rate      NUMERIC,
  pct_score_batter_xslg_regression  NUMERIC,
  pct_score_batter_xba              NUMERIC,
  pct_score_batter_exit_velo_trend  NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT
      ph.mlb_market_type AS market,
      ph.breakdown,
      (ph.created_at::date >= '2026-06-19'::date) AS post_d630
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN (
      'batter_hr','batter_rbis','batter_runs_scored',
      'batter_strikeouts','pitcher_outs','game_total'
    )
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '35 days'
      AND ph.breakdown IS NOT NULL
  )
  SELECT
    base.market,
    (CASE WHEN base.post_d630 THEN 'post_d630' ELSE 'pre_d630' END)::TEXT AS cohort,
    COUNT(*) AS n,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_weather_temp')='number'
        AND (base.breakdown->>'score_weather_temp')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_weather_temp,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_weather_wind')='number'
        AND (base.breakdown->>'score_weather_wind')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_weather_wind,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_wind_direction_hr')='number'
        AND (base.breakdown->>'score_wind_direction_hr')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_wind_direction_hr,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_batter_barrel_rate')='number'
        AND (base.breakdown->>'score_batter_barrel_rate')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_barrel_rate,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_batter_xslg_regression')='number'
        AND (base.breakdown->>'score_batter_xslg_regression')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_xslg_regression,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_batter_xba')='number'
        AND (base.breakdown->>'score_batter_xba')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_xba,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(base.breakdown->'score_batter_exit_velo_trend')='number'
        AND (base.breakdown->>'score_batter_exit_velo_trend')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_exit_velo_trend
  FROM base
  GROUP BY base.market, base.post_d630
  ORDER BY base.market, base.post_d630;
END $$;
GRANT EXECUTE ON FUNCTION public.d638_q4() TO service_role;
