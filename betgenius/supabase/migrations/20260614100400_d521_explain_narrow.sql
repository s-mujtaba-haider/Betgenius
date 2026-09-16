-- D-521 — Compare deep-page cost with NARROW SELECT (only the 42 cols the
-- Admin Performance panel actually reads — Admin.tsx:21 PickHistoryRow interface)
-- vs SELECT *. PostgREST default is SELECT *; switching to narrow select=
-- skips detoasting the wide `breakdown` JSONB column on every row.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-521 §G.1] NARROW-SELECT page 1 (LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, player_name, team, opponent, is_home, prop_type, line, pick_side, odds,
           confidence, hit, actual_value, voided, recommendation_shown, game_date, created_at,
           score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
           score_home_away, score_rest, score_b2b, score_minutes_trend, score_pace,
           score_opp_defense, score_odds_value, score_trend, score_z_score, score_role_change,
           score_vig_filter, score_usg_rate, score_regression, score_market_conf,
           score_home_away_split, score_minutes_floor, score_consistency,
           score_prop_type_penalty, score_stale_data, score_player_injury
    FROM public.pick_history
    WHERE voided IS NOT TRUE
      AND is_synthetic = false
      AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
      AND game_date IS NOT NULL
    ORDER BY game_date DESC, created_at DESC
    LIMIT 1000
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-521 §G.2] NARROW-SELECT deep page (OFFSET 40000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, player_name, team, opponent, is_home, prop_type, line, pick_side, odds,
           confidence, hit, actual_value, voided, recommendation_shown, game_date, created_at,
           score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
           score_home_away, score_rest, score_b2b, score_minutes_trend, score_pace,
           score_opp_defense, score_odds_value, score_trend, score_z_score, score_role_change,
           score_vig_filter, score_usg_rate, score_regression, score_market_conf,
           score_home_away_split, score_minutes_floor, score_consistency,
           score_prop_type_penalty, score_stale_data, score_player_injury
    FROM public.pick_history
    WHERE voided IS NOT TRUE
      AND is_synthetic = false
      AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
      AND game_date IS NOT NULL
    ORDER BY game_date DESC, created_at DESC
    OFFSET 40000 LIMIT 1000
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
