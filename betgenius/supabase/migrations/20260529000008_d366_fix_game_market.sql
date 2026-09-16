-- D-366 SHIP 1 patch — recognize 'game_side' and 'game_total' as the actual
-- stored prop_type values for game-market picks. Previously the CASE WHEN
-- listed the unclassified raw values (h2h/totals/etc); pick_history stores
-- the classifyMarket() output instead. Result: 1,539 of 13,671 picks (~11%)
-- had their game-market weight deltas silently dropped.
--
-- Confirmed via d366_prop_type_histogram probe: 7 distinct prop_types in MV =
--   batter_hits, batter_rbis, batter_total_bases, batter_home_runs,
--   game_total, game_side, pitcher_strikeouts.
--
-- Rollback: re-apply 20260529000007_d366_fix_zero_currents.sql.

CREATE OR REPLACE FUNCTION public.d366_score_at_weights(
  p_weights JSONB,
  p_current_weights JSONB,
  p_min_conf INT DEFAULT 60
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result JSONB;
BEGIN
  WITH recomputed AS (
    SELECT
      hit,
      prop_type,
      confidence

        -- 13 D-362 weights (universal)
        + s_pitcher_xera_edge           * COALESCE((((p_weights ->> 'w_mlb_pitcher_xera_edge')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_pitcher_xera_edge')::numeric, 0))           - 1), 0)
        + s_pitcher_baa                  * COALESCE((((p_weights ->> 'w_mlb_pitcher_baa')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_pitcher_baa')::numeric, 0))                 - 1), 0)
        + s_catcher_framing              * COALESCE((((p_weights ->> 'w_mlb_catcher_framing')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_catcher_framing')::numeric, 0))             - 1), 0)
        + s_pitcher_pitch_mix_k          * COALESCE((((p_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric, 0))         - 1), 0)
        + s_batter_xba                   * COALESCE((((p_weights ->> 'w_mlb_batter_xba')::numeric                  / NULLIF((p_current_weights ->> 'w_mlb_batter_xba')::numeric, 0))                  - 1), 0)
        + s_batter_exit_velo_trend       * COALESCE((((p_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric, 0))      - 1), 0)
        + s_batter_barrel_rate           * COALESCE((((p_weights ->> 'w_mlb_batter_barrel_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_batter_barrel_rate')::numeric, 0))          - 1), 0)
        + s_batter_xslg_regression       * COALESCE((((p_weights ->> 'w_mlb_batter_xslg_regression')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_xslg_regression')::numeric, 0))      - 1), 0)
        + s_batter_babip                 * COALESCE((((p_weights ->> 'w_mlb_batter_babip')::numeric                / NULLIF((p_current_weights ->> 'w_mlb_batter_babip')::numeric, 0))                - 1), 0)
        + s_batter_vs_pitcher_hand_split * COALESCE((((p_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric/ NULLIF((p_current_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric, 0))- 1), 0)
        + s_bullpen_quality              * COALESCE((((p_weights ->> 'w_mlb_bullpen_quality')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_bullpen_quality')::numeric, 0))             - 1), 0)
        + s_wind_direction_hr            * COALESCE((((p_weights ->> 'w_mlb_wind_direction_hr')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_wind_direction_hr')::numeric, 0))           - 1), 0)
        + s_pitcher_hr_per_9             * COALESCE((((p_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric, 0))            - 1), 0)

        -- 10 D-340 PITCHER weights — only 'pitcher_strikeouts'/'pitcher_k' rows.
        + CASE WHEN prop_type IN ('pitcher_strikeouts', 'pitcher_k') THEN
              s_pitcher_k_rate       * COALESCE((((p_weights ->> 'w_mlb_pitcher_k_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_pitcher_k_rate')::numeric, 0))          - 1), 0)
            + s_pitcher_form         * COALESCE((((p_weights ->> 'w_mlb_pitcher_form')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_form')::numeric, 0))            - 1), 0)
            + s_opposing_lineup_k    * COALESCE((((p_weights ->> 'w_mlb_opposing_lineup_k')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_opposing_lineup_k')::numeric, 0))       - 1), 0)
            + s_handedness_matchup   * COALESCE((((p_weights ->> 'w_mlb_handedness_matchup')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_handedness_matchup')::numeric, 0))      - 1), 0)
            + s_pitch_count_trend    * COALESCE((((p_weights ->> 'w_mlb_pitch_count_trend')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_pitch_count_trend')::numeric, 0))       - 1), 0)
            + s_rest_pitcher         * COALESCE((((p_weights ->> 'w_mlb_rest_pitcher')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_rest_pitcher')::numeric, 0))            - 1), 0)
            + s_ballpark_factor      * COALESCE((((p_weights ->> 'w_mlb_pitcher_ballpark_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_pitcher_ballpark_factor')::numeric, 0)) - 1), 0)
            + s_weather_wind         * COALESCE((((p_weights ->> 'w_mlb_pitcher_weather_wind')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_wind')::numeric, 0))    - 1), 0)
            + s_weather_temp         * COALESCE((((p_weights ->> 'w_mlb_pitcher_weather_temp')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_temp')::numeric, 0))    - 1), 0)
            + s_umpire_k_zone        * COALESCE((((p_weights ->> 'w_mlb_pitcher_umpire_k_zone')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_pitcher_umpire_k_zone')::numeric, 0))   - 1), 0)
          ELSE 0 END

        -- 12 D-340 BATTER weights — prop_type LIKE 'batter_%'.
        + CASE WHEN prop_type LIKE 'batter_%' THEN
              s_batter_hit_rate            * COALESCE((((p_weights ->> 'w_mlb_batter_hit_rate')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_batter_hit_rate')::numeric, 0))             - 1), 0)
            + s_batter_form                * COALESCE((((p_weights ->> 'w_mlb_batter_form')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_batter_form')::numeric, 0))                 - 1), 0)
            + s_opposing_pitcher_quality   * COALESCE((((p_weights ->> 'w_mlb_batter_pitcher_quality')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_quality')::numeric, 0))      - 1), 0)
            + s_recent_at_bats             * COALESCE((((p_weights ->> 'w_mlb_batter_recent_ab')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_batter_recent_ab')::numeric, 0))            - 1), 0)
            + s_handedness_matchup         * COALESCE((((p_weights ->> 'w_mlb_batter_handedness_matchup')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_handedness_matchup')::numeric, 0))   - 1), 0)
            + s_ballpark_factor            * COALESCE((((p_weights ->> 'w_mlb_batter_ballpark_hits_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_batter_ballpark_hits_factor')::numeric, 0)) - 1), 0)
            + s_weather_temp               * COALESCE((((p_weights ->> 'w_mlb_batter_weather_temp')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_temp')::numeric, 0))         - 1), 0)
            + s_lineup_consistency         * COALESCE((((p_weights ->> 'w_mlb_batter_lineup_consistency')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_lineup_consistency')::numeric, 0))   - 1), 0)
            + s_batter_power_rate          * COALESCE((((p_weights ->> 'w_mlb_batter_power_rate')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_power_rate')::numeric, 0))           - 1), 0)
            + s_batter_form_power          * COALESCE((((p_weights ->> 'w_mlb_batter_form_power')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_form_power')::numeric, 0))           - 1), 0)
            + s_pitcher_hr_rate            * COALESCE((((p_weights ->> 'w_mlb_batter_pitcher_hr_rate')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_hr_rate')::numeric, 0))      - 1), 0)
            + s_weather_wind               * COALESCE((((p_weights ->> 'w_mlb_batter_weather_wind')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_wind')::numeric, 0))         - 1), 0)
          ELSE 0 END

        -- 11 D-340 GAME weights — prop_type 'game_side' or 'game_total'.
        + CASE WHEN prop_type IN ('game_side', 'game_total') THEN
              s_offense_differential   * COALESCE((((p_weights ->> 'w_mlb_game_offense_diff')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_offense_diff')::numeric, 0))      - 1), 0)
            + s_pitching_matchup       * COALESCE((((p_weights ->> 'w_mlb_game_pitching_matchup')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_pitching_matchup')::numeric, 0))  - 1), 0)
            + s_bullpen_strength       * COALESCE((((p_weights ->> 'w_mlb_game_bullpen_strength')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_bullpen_strength')::numeric, 0))  - 1), 0)
            + s_recent_run_diff        * COALESCE((((p_weights ->> 'w_mlb_game_recent_run_diff')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_game_recent_run_diff')::numeric, 0))   - 1), 0)
            + s_h2h_recent             * COALESCE((((p_weights ->> 'w_mlb_game_h2h_recent')::numeric        / NULLIF((p_current_weights ->> 'w_mlb_game_h2h_recent')::numeric, 0))        - 1), 0)
            + s_team_form              * COALESCE((((p_weights ->> 'w_mlb_game_team_form')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_game_team_form')::numeric, 0))         - 1), 0)
            + s_ballpark_factor        * COALESCE((((p_weights ->> 'w_mlb_game_ballpark')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_game_ballpark')::numeric, 0))          - 1), 0)
            + s_weather_wind           * COALESCE((((p_weights ->> 'w_mlb_game_weather_wind')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_wind')::numeric, 0))      - 1), 0)
            + s_weather_temp           * COALESCE((((p_weights ->> 'w_mlb_game_weather_temp')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_temp')::numeric, 0))      - 1), 0)
            + s_umpire_k_zone          * COALESCE((((p_weights ->> 'w_mlb_game_umpire_k_zone')::numeric     / NULLIF((p_current_weights ->> 'w_mlb_game_umpire_k_zone')::numeric, 0))     - 1), 0)
            + s_lineup_vs_hand_split   * COALESCE((((p_weights ->> 'w_mlb_lineup_vs_hand_split')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_lineup_vs_hand_split')::numeric, 0))   - 1), 0)
          ELSE 0 END
      AS new_conf
    FROM public.d366_factor_scores
  ),
  agg AS (
    SELECT
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf) AS n,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf AND hit IS TRUE) AS hits,
      COUNT(*) FILTER (WHERE new_conf >= 60 AND new_conf < 70 AND hit IS TRUE) AS lean_hits,
      COUNT(*) FILTER (WHERE new_conf >= 60 AND new_conf < 70) AS lean_n,
      COUNT(*) FILTER (WHERE new_conf >= 70 AND new_conf < 80 AND hit IS TRUE) AS good_hits,
      COUNT(*) FILTER (WHERE new_conf >= 70 AND new_conf < 80) AS good_n,
      COUNT(*) FILTER (WHERE new_conf >= 80 AND new_conf < 90 AND hit IS TRUE) AS strong_hits,
      COUNT(*) FILTER (WHERE new_conf >= 80 AND new_conf < 90) AS strong_n,
      COUNT(*) FILTER (WHERE new_conf >= 90 AND hit IS TRUE) AS elite_hits,
      COUNT(*) FILTER (WHERE new_conf >= 90) AS elite_n
    FROM recomputed
  )
  SELECT jsonb_build_object(
    'objective_n', n, 'objective_hits', hits,
    'objective_hit_rate', CASE WHEN n > 0 THEN hits::numeric / n ELSE 0 END,
    'lean_n', lean_n, 'lean_hits', lean_hits,
    'lean_hr', CASE WHEN lean_n > 0 THEN lean_hits::numeric / lean_n ELSE 0 END,
    'good_n', good_n, 'good_hits', good_hits,
    'good_hr', CASE WHEN good_n > 0 THEN good_hits::numeric / good_n ELSE 0 END,
    'strong_n', strong_n, 'strong_hits', strong_hits,
    'strong_hr', CASE WHEN strong_n > 0 THEN strong_hits::numeric / strong_n ELSE 0 END,
    'elite_n', elite_n, 'elite_hits', elite_hits,
    'elite_hr', CASE WHEN elite_n > 0 THEN elite_hits::numeric / elite_n ELSE 0 END
  ) INTO v_result FROM agg;
  RETURN v_result;
END $$;
