-- D-648 — READ-ONLY game-side factor population + offense/pitching split.

-- Q1 — per-factor pct_active on real game-side picks, split by market.
-- game_side maps to mlb_market_type = 'game_side' (spreads + h2h);
-- game_total maps to 'game_total'.
CREATE OR REPLACE FUNCTION public.d648_q1_game_factor_pop()
RETURNS TABLE (
  mkt TEXT, factor_name TEXT,
  n_total BIGINT, n_present BIGINT,
  n_zero BIGINT, n_active BIGINT,
  pct_present NUMERIC, pct_active NUMERIC,
  verdict TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.mlb_market_type AS mkt, ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN ('game_side','game_total')
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '21 days'
      AND ph.breakdown IS NOT NULL
  ),
  totals AS ( SELECT base.mkt, COUNT(*) AS n_total FROM base GROUP BY base.mkt ),
  keys AS (
    SELECT b.mkt, kv.key, kv.value
    FROM base b, LATERAL jsonb_each(b.breakdown) AS kv
    WHERE kv.key LIKE 'score\_%' ESCAPE '\'
  ),
  agg AS (
    SELECT k.mkt, k.key AS factor_name, COUNT(*) AS n_present,
      SUM(CASE WHEN jsonb_typeof(k.value)='number'
               AND (k.value)::text::numeric = 0 THEN 1 ELSE 0 END) AS n_zero,
      SUM(CASE WHEN jsonb_typeof(k.value)='number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active
    FROM keys k GROUP BY k.mkt, k.key
  )
  SELECT a.mkt, a.factor_name, t.n_total, a.n_present,
    a.n_zero, a.n_active,
    ROUND(100.0 * a.n_present / NULLIF(t.n_total, 0), 1),
    ROUND(100.0 * a.n_active / NULLIF(t.n_total, 0), 1),
    CASE
      WHEN 100.0 * a.n_active / NULLIF(t.n_total,0) <  1 THEN 'DEAD'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total,0) <  5 THEN 'NEAR_DEAD'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total,0) < 25 THEN 'LOW'
      WHEN 100.0 * a.n_active / NULLIF(t.n_total,0) < 60 THEN 'PARTIAL'
      ELSE 'HEALTHY'
    END
  FROM agg a JOIN totals t ON t.mkt = a.mkt
  ORDER BY a.mkt, pct_active ASC;
END $$;
GRANT EXECUTE ON FUNCTION public.d648_q1_game_factor_pop() TO service_role;

-- Q2 — per-pick: how many factors actually fire? Distribution + median
-- per market. Confirms the "2-5 per game" pattern.
CREATE OR REPLACE FUNCTION public.d648_q2_factors_per_pick()
RETURNS TABLE (
  mkt TEXT, n_picks BIGINT, avg_active NUMERIC,
  p10 NUMERIC, p50 NUMERIC, p90 NUMERIC,
  min_active INT, max_active INT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.id, ph.mlb_market_type AS mkt, ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN ('game_side','game_total')
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '21 days'
      AND ph.breakdown IS NOT NULL
  ),
  counts AS (
    SELECT b.id, b.mkt,
      (SELECT COUNT(*) FROM jsonb_each(b.breakdown) AS kv
        WHERE kv.key LIKE 'score\_%' ESCAPE '\'
          AND jsonb_typeof(kv.value)='number'
          AND (kv.value)::text::numeric <> 0
      )::INT AS n_active
    FROM base b
  )
  SELECT c.mkt, COUNT(*) AS n_picks,
    ROUND(AVG(c.n_active)::NUMERIC, 2),
    PERCENTILE_DISC(0.10) WITHIN GROUP (ORDER BY c.n_active),
    PERCENTILE_DISC(0.50) WITHIN GROUP (ORDER BY c.n_active),
    PERCENTILE_DISC(0.90) WITHIN GROUP (ORDER BY c.n_active),
    MIN(c.n_active)::INT, MAX(c.n_active)::INT
  FROM counts c GROUP BY c.mkt ORDER BY c.mkt;
END $$;
GRANT EXECUTE ON FUNCTION public.d648_q2_factors_per_pick() TO service_role;

-- Q3 — algorithm_weights snapshot of W_GAME entries. Confirms which
-- factor weights are LIVE non-zero vs zeroed-out.
CREATE OR REPLACE FUNCTION public.d648_q3_game_weights()
RETURNS TABLE (col_name TEXT, val NUMERIC)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  RETURN QUERY
  SELECT k.k::TEXT, k.v::NUMERIC
  FROM (
    SELECT 'w_mlb_game_offense_diff'::TEXT      AS k, w_mlb_game_offense_diff      AS v FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_pitching_matchup', w_mlb_game_pitching_matchup FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_bullpen_strength', w_mlb_game_bullpen_strength FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_lineup_vs_hand_split', w_mlb_lineup_vs_hand_split FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_recent_run_diff', w_mlb_game_recent_run_diff FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_h2h_recent', w_mlb_game_h2h_recent FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_team_form', w_mlb_game_team_form FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_ballpark', w_mlb_game_ballpark FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_weather_wind', w_mlb_game_weather_wind FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_game_weather_temp', w_mlb_game_weather_temp FROM algorithm_weights WHERE id=1
    UNION ALL SELECT 'w_mlb_umpire_run_factor', w_mlb_umpire_run_factor FROM algorithm_weights WHERE id=1
  ) k;
END $$;
GRANT EXECUTE ON FUNCTION public.d648_q3_game_weights() TO service_role;

-- Q4 — confirm score_offense_differential is the only OFFENSE-pure
-- factor besides lineup_vs_hand_split. Sample what input fields are in
-- breakdown for game-side picks today (to see if team_ops / wOBA / etc
-- exist at all).
CREATE OR REPLACE FUNCTION public.d648_q4_offense_inputs()
RETURNS TABLE (input_name TEXT, n_present BIGINT, n_nonnull BIGINT, sample_value TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN ('game_side','game_total')
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '7 days'
      AND ph.breakdown IS NOT NULL
    LIMIT 5000
  ),
  cands AS (
    SELECT unnest(ARRAY[
      'home_rpg','away_rpg','home_rapg','away_rapg',
      'home_ops','away_ops','home_woba','away_woba',
      'home_woba_vs_lhp','home_woba_vs_rhp','away_woba_vs_lhp','away_woba_vs_rhp',
      'home_vs_lhp_ops','home_vs_rhp_ops','away_vs_lhp_ops','away_vs_rhp_ops',
      'home_lineup_pa','away_lineup_pa',
      'home_pitcher_era','away_pitcher_era',
      'home_bullpen_era','away_bullpen_era',
      'home_l10_runs','home_l10_runs_allowed','away_l10_runs','away_l10_runs_allowed',
      'home_team_form','away_team_form',
      'park_runs_factor','weather_temp_f','weather_wind_mph',
      'proj_home_runs','proj_away_runs','proj_total','proj_diff',
      'home_handedness_l_pct','away_handedness_l_pct'
    ]) AS k
  )
  SELECT cands.k::TEXT,
    (SELECT COUNT(*) FROM base WHERE breakdown ? cands.k),
    (SELECT COUNT(*) FROM base WHERE breakdown ? cands.k AND jsonb_typeof(breakdown->cands.k) <> 'null'),
    (SELECT (breakdown->>cands.k)::TEXT FROM base WHERE breakdown ? cands.k AND jsonb_typeof(breakdown->cands.k) <> 'null' LIMIT 1)
  FROM cands
  ORDER BY 2 DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d648_q4_offense_inputs() TO service_role;
