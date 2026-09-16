-- Tier 4 #10 Phase 1 — pairwise factor correlation diagnostic (read-only).
-- Sample: post-May-4 organic resolved unvoided picks (n=733).
-- Column names normalized to actual pick_history schema after
-- 20260512000030 schema check:
--   score_minutes_trend (not score_min_trend)
--   score_minutes_floor (not score_min_floor)
--   score_opp_defense   (not score_opp_def)
--   score_prop_type_penalty (not score_prop_type)
--   score_home_away_split (not score_ha_split)
-- 22-factor universe per §4 — pulls every score_* column present in the
-- table; orphans (score_h2h, score_ha_record, score_net_rating, etc.) are
-- spread/game_total-only and excluded from prop-pick correlation work.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== Pairwise factor correlations (post-May-4 organic resolved, n=733) ===';
  RAISE NOTICE '% | % | %', RPAD('pair', 36), LPAD('corr', 8), LPAD('n', 5);
  FOR r IN
    WITH u AS (
      SELECT score_l5, score_l10, score_season, score_floor_ceiling,
             score_recent_form, score_home_away, score_rest, score_b2b,
             score_minutes_trend, score_pace, score_opp_defense,
             score_prop_type_penalty, score_z_score, score_role_change,
             score_vig_filter, score_usg_rate, score_regression,
             score_market_conf, score_home_away_split, score_minutes_floor,
             score_consistency, score_stale_data, score_player_injury,
             score_trivial_line_penalty
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date >= '2026-05-04'
        AND hit IS NOT NULL AND voided = false
    )
    SELECT pair, ROUND(corr::NUMERIC, 3) AS corr, n FROM (
      SELECT 'l5_vs_l10' AS pair, CORR(score_l5, score_l10) AS corr, COUNT(*) AS n FROM u
      UNION ALL SELECT 'l5_vs_recent_form', CORR(score_l5, score_recent_form), COUNT(*) FROM u
      UNION ALL SELECT 'l10_vs_recent_form', CORR(score_l10, score_recent_form), COUNT(*) FROM u
      UNION ALL SELECT 'l5_vs_season', CORR(score_l5, score_season), COUNT(*) FROM u
      UNION ALL SELECT 'l10_vs_season', CORR(score_l10, score_season), COUNT(*) FROM u
      UNION ALL SELECT 'recent_form_vs_season', CORR(score_recent_form, score_season), COUNT(*) FROM u
      UNION ALL SELECT 'min_trend_vs_min_floor', CORR(score_minutes_trend, score_minutes_floor), COUNT(*) FROM u
      UNION ALL SELECT 'rest_vs_b2b', CORR(score_rest, score_b2b), COUNT(*) FROM u
      UNION ALL SELECT 'pace_vs_opp_def', CORR(score_pace, score_opp_defense), COUNT(*) FROM u
      UNION ALL SELECT 'consistency_vs_floor_ceiling', CORR(score_consistency, score_floor_ceiling), COUNT(*) FROM u
      UNION ALL SELECT 'regression_vs_recent_form', CORR(score_regression, score_recent_form), COUNT(*) FROM u
      UNION ALL SELECT 'regression_vs_season', CORR(score_regression, score_season), COUNT(*) FROM u
      UNION ALL SELECT 'market_conf_vs_z_score', CORR(score_market_conf, score_z_score), COUNT(*) FROM u
      UNION ALL SELECT 'market_conf_vs_vig_filter', CORR(score_market_conf, score_vig_filter), COUNT(*) FROM u
      UNION ALL SELECT 'usg_vs_role_change', CORR(score_usg_rate, score_role_change), COUNT(*) FROM u
      UNION ALL SELECT 'ha_split_vs_home_away', CORR(score_home_away_split, score_home_away), COUNT(*) FROM u
      UNION ALL SELECT 'trivial_vs_vig_filter', CORR(score_trivial_line_penalty, score_vig_filter), COUNT(*) FROM u
      UNION ALL SELECT 'stale_data_vs_min_trend', CORR(score_stale_data, score_minutes_trend), COUNT(*) FROM u
    ) ranked
    ORDER BY ABS(COALESCE(corr, 0)) DESC, pair
  LOOP
    RAISE NOTICE '% | % | %',
      RPAD(r.pair, 36),
      LPAD(COALESCE(r.corr::TEXT, 'NULL'), 8),
      LPAD(r.n::TEXT, 5);
  END LOOP;
END $$;
