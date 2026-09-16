-- D-366 SHIP 3 — batched grid-search SQL function.
-- One RPC call evaluates an entire grid of trial values for ONE weight column,
-- running through the MV once and producing |grid| stat rows.
-- Eliminates the per-trial network round-trip that blew the 150s edge function budget.
--
-- Rollback: DROP FUNCTION public.d366_search_weight_grid(text, jsonb, jsonb, numeric[], int);

CREATE OR REPLACE FUNCTION public.d366_search_weight_grid(
  p_weight_col TEXT,
  p_base_weights JSONB,
  p_current_weights JSONB,
  p_grid NUMERIC[],
  p_min_conf INT DEFAULT 60
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result JSONB;
BEGIN
  WITH g AS (
    SELECT gv FROM unnest(p_grid) AS gv
  ),
  -- For each grid value, build the trial weights JSONB and pair with every MV row.
  -- This is a CROSS JOIN — |grid| × 13,671 rows — but a single table scan.
  trials AS (
    SELECT
      g.gv,
      jsonb_set(p_base_weights, ARRAY[p_weight_col], to_jsonb(g.gv)) AS pw
    FROM g
  ),
  scored AS (
    SELECT
      t.gv,
      fs.hit,
      fs.confidence

        + fs.s_pitcher_xera_edge           * COALESCE((((t.pw ->> 'w_mlb_pitcher_xera_edge')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_pitcher_xera_edge')::numeric, 0))           - 1), 0)
        + fs.s_pitcher_baa                  * COALESCE((((t.pw ->> 'w_mlb_pitcher_baa')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_pitcher_baa')::numeric, 0))                 - 1), 0)
        + fs.s_catcher_framing              * COALESCE((((t.pw ->> 'w_mlb_catcher_framing')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_catcher_framing')::numeric, 0))             - 1), 0)
        + fs.s_pitcher_pitch_mix_k          * COALESCE((((t.pw ->> 'w_mlb_pitcher_pitch_mix_k')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric, 0))         - 1), 0)
        + fs.s_batter_xba                   * COALESCE((((t.pw ->> 'w_mlb_batter_xba')::numeric                  / NULLIF((p_current_weights ->> 'w_mlb_batter_xba')::numeric, 0))                  - 1), 0)
        + fs.s_batter_exit_velo_trend       * COALESCE((((t.pw ->> 'w_mlb_batter_exit_velo_trend')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric, 0))      - 1), 0)
        + fs.s_batter_barrel_rate           * COALESCE((((t.pw ->> 'w_mlb_batter_barrel_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_batter_barrel_rate')::numeric, 0))          - 1), 0)
        + fs.s_batter_xslg_regression       * COALESCE((((t.pw ->> 'w_mlb_batter_xslg_regression')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_xslg_regression')::numeric, 0))      - 1), 0)
        + fs.s_batter_babip                 * COALESCE((((t.pw ->> 'w_mlb_batter_babip')::numeric                / NULLIF((p_current_weights ->> 'w_mlb_batter_babip')::numeric, 0))                - 1), 0)
        + fs.s_batter_vs_pitcher_hand_split * COALESCE((((t.pw ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric/ NULLIF((p_current_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric, 0))- 1), 0)
        + fs.s_bullpen_quality              * COALESCE((((t.pw ->> 'w_mlb_bullpen_quality')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_bullpen_quality')::numeric, 0))             - 1), 0)
        + fs.s_wind_direction_hr            * COALESCE((((t.pw ->> 'w_mlb_wind_direction_hr')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_wind_direction_hr')::numeric, 0))           - 1), 0)
        + fs.s_pitcher_hr_per_9             * COALESCE((((t.pw ->> 'w_mlb_pitcher_hr_per_9')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric, 0))            - 1), 0)

        + CASE WHEN fs.prop_type IN ('pitcher_strikeouts', 'pitcher_k') THEN
              fs.s_pitcher_k_rate       * COALESCE((((t.pw ->> 'w_mlb_pitcher_k_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_pitcher_k_rate')::numeric, 0))          - 1), 0)
            + fs.s_pitcher_form         * COALESCE((((t.pw ->> 'w_mlb_pitcher_form')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_form')::numeric, 0))            - 1), 0)
            + fs.s_opposing_lineup_k    * COALESCE((((t.pw ->> 'w_mlb_opposing_lineup_k')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_opposing_lineup_k')::numeric, 0))       - 1), 0)
            + fs.s_handedness_matchup   * COALESCE((((t.pw ->> 'w_mlb_handedness_matchup')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_handedness_matchup')::numeric, 0))      - 1), 0)
            + fs.s_pitch_count_trend    * COALESCE((((t.pw ->> 'w_mlb_pitch_count_trend')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_pitch_count_trend')::numeric, 0))       - 1), 0)
            + fs.s_rest_pitcher         * COALESCE((((t.pw ->> 'w_mlb_rest_pitcher')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_rest_pitcher')::numeric, 0))            - 1), 0)
            + fs.s_ballpark_factor      * COALESCE((((t.pw ->> 'w_mlb_pitcher_ballpark_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_pitcher_ballpark_factor')::numeric, 0)) - 1), 0)
            + fs.s_weather_wind         * COALESCE((((t.pw ->> 'w_mlb_pitcher_weather_wind')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_wind')::numeric, 0))    - 1), 0)
            + fs.s_weather_temp         * COALESCE((((t.pw ->> 'w_mlb_pitcher_weather_temp')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_temp')::numeric, 0))    - 1), 0)
            + fs.s_umpire_k_zone        * COALESCE((((t.pw ->> 'w_mlb_pitcher_umpire_k_zone')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_pitcher_umpire_k_zone')::numeric, 0))   - 1), 0)
          ELSE 0 END

        + CASE WHEN fs.prop_type LIKE 'batter_%' THEN
              fs.s_batter_hit_rate            * COALESCE((((t.pw ->> 'w_mlb_batter_hit_rate')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_batter_hit_rate')::numeric, 0))             - 1), 0)
            + fs.s_batter_form                * COALESCE((((t.pw ->> 'w_mlb_batter_form')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_batter_form')::numeric, 0))                 - 1), 0)
            + fs.s_opposing_pitcher_quality   * COALESCE((((t.pw ->> 'w_mlb_batter_pitcher_quality')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_quality')::numeric, 0))      - 1), 0)
            + fs.s_recent_at_bats             * COALESCE((((t.pw ->> 'w_mlb_batter_recent_ab')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_batter_recent_ab')::numeric, 0))            - 1), 0)
            + fs.s_handedness_matchup         * COALESCE((((t.pw ->> 'w_mlb_batter_handedness_matchup')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_handedness_matchup')::numeric, 0))   - 1), 0)
            + fs.s_ballpark_factor            * COALESCE((((t.pw ->> 'w_mlb_batter_ballpark_hits_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_batter_ballpark_hits_factor')::numeric, 0)) - 1), 0)
            + fs.s_weather_temp               * COALESCE((((t.pw ->> 'w_mlb_batter_weather_temp')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_temp')::numeric, 0))         - 1), 0)
            + fs.s_lineup_consistency         * COALESCE((((t.pw ->> 'w_mlb_batter_lineup_consistency')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_lineup_consistency')::numeric, 0))   - 1), 0)
            + fs.s_batter_power_rate          * COALESCE((((t.pw ->> 'w_mlb_batter_power_rate')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_power_rate')::numeric, 0))           - 1), 0)
            + fs.s_batter_form_power          * COALESCE((((t.pw ->> 'w_mlb_batter_form_power')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_form_power')::numeric, 0))           - 1), 0)
            + fs.s_pitcher_hr_rate            * COALESCE((((t.pw ->> 'w_mlb_batter_pitcher_hr_rate')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_hr_rate')::numeric, 0))      - 1), 0)
            + fs.s_weather_wind               * COALESCE((((t.pw ->> 'w_mlb_batter_weather_wind')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_wind')::numeric, 0))         - 1), 0)
          ELSE 0 END

        + CASE WHEN fs.prop_type IN ('game_side', 'game_total') THEN
              fs.s_offense_differential   * COALESCE((((t.pw ->> 'w_mlb_game_offense_diff')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_offense_diff')::numeric, 0))      - 1), 0)
            + fs.s_pitching_matchup       * COALESCE((((t.pw ->> 'w_mlb_game_pitching_matchup')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_pitching_matchup')::numeric, 0))  - 1), 0)
            + fs.s_bullpen_strength       * COALESCE((((t.pw ->> 'w_mlb_game_bullpen_strength')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_bullpen_strength')::numeric, 0))  - 1), 0)
            + fs.s_recent_run_diff        * COALESCE((((t.pw ->> 'w_mlb_game_recent_run_diff')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_game_recent_run_diff')::numeric, 0))   - 1), 0)
            + fs.s_h2h_recent             * COALESCE((((t.pw ->> 'w_mlb_game_h2h_recent')::numeric        / NULLIF((p_current_weights ->> 'w_mlb_game_h2h_recent')::numeric, 0))        - 1), 0)
            + fs.s_team_form              * COALESCE((((t.pw ->> 'w_mlb_game_team_form')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_game_team_form')::numeric, 0))         - 1), 0)
            + fs.s_ballpark_factor        * COALESCE((((t.pw ->> 'w_mlb_game_ballpark')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_game_ballpark')::numeric, 0))          - 1), 0)
            + fs.s_weather_wind           * COALESCE((((t.pw ->> 'w_mlb_game_weather_wind')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_wind')::numeric, 0))      - 1), 0)
            + fs.s_weather_temp           * COALESCE((((t.pw ->> 'w_mlb_game_weather_temp')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_temp')::numeric, 0))      - 1), 0)
            + fs.s_umpire_k_zone          * COALESCE((((t.pw ->> 'w_mlb_game_umpire_k_zone')::numeric     / NULLIF((p_current_weights ->> 'w_mlb_game_umpire_k_zone')::numeric, 0))     - 1), 0)
            + fs.s_lineup_vs_hand_split   * COALESCE((((t.pw ->> 'w_mlb_lineup_vs_hand_split')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_lineup_vs_hand_split')::numeric, 0))   - 1), 0)
          ELSE 0 END
        AS new_conf
    FROM trials t CROSS JOIN public.d366_factor_scores fs
  ),
  agg AS (
    SELECT
      gv,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf) AS n,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf AND hit IS TRUE) AS hits
    FROM scored
    GROUP BY gv
  )
  SELECT jsonb_object_agg(
    gv::text,
    jsonb_build_object(
      'objective_n', n,
      'objective_hits', hits,
      'objective_hit_rate', CASE WHEN n > 0 THEN hits::numeric / n ELSE 0 END
    )
  ) INTO v_result FROM agg;
  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.d366_search_weight_grid(text, jsonb, jsonb, numeric[], int) TO service_role, authenticated;
