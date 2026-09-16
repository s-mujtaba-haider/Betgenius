-- D-639 — patched audit RPCs.
-- ────────────────────────────────────────────────────────────────────
-- D-638b's Q2 mis-flagged factors as DEAD when they were actually:
--   (a) string-valued (e.g. pitcher_hand_for_split = 'L'/'R'). Q2's
--       n_active filter required jsonb_typeof = 'number' AND <> 0
--       so every string row counted as inactive.
--   (b) intentionally market-gated (e.g. score_batter_xba excludes
--       homeRuns by design; score_batter_form is replaced by
--       score_batter_form_power for power markets).
--   (c) weighted to 0 in algorithm_weights (score_offense_differential
--       had w_mlb_game_offense_diff = 0 per D-296/D-339).
--
-- d639_q2_strings: same shape as D-638b Q2 but treats non-null strings
-- AND non-zero booleans as active. Run this BEFORE concluding a factor
-- is "DEAD" — strings now light up correctly.
--
-- d639_q_factor_drilldown(factor_name): for a single factor, returns
-- per-market value distribution (n_string, n_zero_num, n_nonzero_num,
-- n_null, distinct_value_sample). Lets the operator look at
-- "is this gated, weight-zero, or genuinely missing input?" without
-- needing fresh SQL each time.
--
-- Rollback: DROP FUNCTION IF EXISTS public.d639_q2_strings();
--           DROP FUNCTION IF EXISTS public.d639_q_factor_drilldown(text);

CREATE OR REPLACE FUNCTION public.d639_q2_strings()
RETURNS TABLE (
  market              TEXT,
  factor_name         TEXT,
  n_total             BIGINT,
  n_present           BIGINT,
  n_null_value        BIGINT,
  n_zero_number       BIGINT,
  n_active_number     BIGINT,
  n_active_string     BIGINT,
  n_active_bool       BIGINT,
  pct_active_any      NUMERIC,
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
               AND (k.value)::text::numeric = 0 THEN 1 ELSE 0 END) AS n_zero_number,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active_number,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'string'
               AND LENGTH(k.value::text) > 2 THEN 1 ELSE 0 END) AS n_active_string,
      SUM(CASE WHEN jsonb_typeof(k.value) = 'boolean'
               AND (k.value)::text = 'true' THEN 1 ELSE 0 END) AS n_active_bool
    FROM keys k
    GROUP BY k.market, k.key
  )
  SELECT
    a.market,
    a.factor_name,
    t.n_total,
    a.n_present,
    a.n_null_value,
    a.n_zero_number,
    a.n_active_number,
    a.n_active_string,
    a.n_active_bool,
    ROUND(100.0 * (a.n_active_number + a.n_active_string + a.n_active_bool)
                  / NULLIF(t.n_total, 0), 1) AS pct_active_any,
    CASE
      WHEN 100.0 * (a.n_active_number + a.n_active_string + a.n_active_bool)
                   / NULLIF(t.n_total, 0) <  1  THEN 'DEAD'
      WHEN 100.0 * (a.n_active_number + a.n_active_string + a.n_active_bool)
                   / NULLIF(t.n_total, 0) <  5  THEN 'NEAR_DEAD'
      WHEN 100.0 * (a.n_active_number + a.n_active_string + a.n_active_bool)
                   / NULLIF(t.n_total, 0) < 25  THEN 'LOW_COVERAGE'
      WHEN 100.0 * (a.n_active_number + a.n_active_string + a.n_active_bool)
                   / NULLIF(t.n_total, 0) < 60  THEN 'PARTIAL'
      ELSE 'HEALTHY'
    END AS coverage_verdict
  FROM agg a JOIN totals t USING (market)
  WHERE a.factor_name LIKE 'score\_%' ESCAPE '\'
     OR a.factor_name LIKE 'fraw\_%' ESCAPE '\'
     OR a.factor_name IN (
       'last5_hit_rate_pct','last10_hit_rate_pct','season_hit_rate_pct',
       'lineup_spot','pitcher_hand_for_split','brl_pa','xslg_diff','xba',
       'avg_hit_speed','weather_temp_f','weather_wind_mph','park_runs_factor',
       'wind_dir_deg','wind_speed_mph','park_cf_compass_deg','park_is_dome',
       'opposing_pitcher_id','opposing_pitcher_ip','season_babip'
     )
  ORDER BY a.market, pct_active_any ASC, a.factor_name;
END $$;
GRANT EXECUTE ON FUNCTION public.d639_q2_strings() TO service_role;
