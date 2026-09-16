-- D-366 SHIP 1 — Extended materialized view + market-aware SQL scoring function.
-- Adds 25 unique score columns from the 33 D-340 weights to the d364 MV foundation.
-- Net result: 38 score columns × 13K-row corpus.
-- Function d366_score_at_weights takes (new_weights, current_weights, min_conf) — required
-- because D-340 defaults are NOT 1.0 (range 0.25..1.5), so delta = stored * (new/curr - 1).
-- Rollback:
--   DROP FUNCTION IF EXISTS public.d366_score_at_weights(jsonb, jsonb, int);
--   DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;
-- (d364_factor_scores untouched.)

DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;

CREATE MATERIALIZED VIEW public.d366_factor_scores AS
SELECT
  id, prop_type, confidence::numeric AS confidence, hit, backfill_run_id,

  -- 13 D-362 score columns (preserved from d364 MV for forward compatibility)
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_xera_edge')::numeric, 0)           AS s_pitcher_xera_edge,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_baa')::numeric, 0)                  AS s_pitcher_baa,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_catcher_framing')::numeric, 0)              AS s_catcher_framing,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_pitch_mix_k')::numeric, 0)          AS s_pitcher_pitch_mix_k,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_xba')::numeric, 0)                   AS s_batter_xba,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_exit_velo_trend')::numeric, 0)       AS s_batter_exit_velo_trend,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_barrel_rate')::numeric, 0)           AS s_batter_barrel_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_xslg_regression')::numeric, 0)       AS s_batter_xslg_regression,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_babip')::numeric, 0)                 AS s_batter_babip,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_vs_pitcher_hand_split')::numeric, 0) AS s_batter_vs_pitcher_hand_split,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_bullpen_quality')::numeric, 0)              AS s_bullpen_quality,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_wind_direction_hr')::numeric, 0)            AS s_wind_direction_hr,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_per_9')::numeric, 0)             AS s_pitcher_hr_per_9,

  -- 25 D-340 unique score columns (some are shared across markets — routing handled in fn)
  -- Pitcher-only
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_k_rate')::numeric, 0)        AS s_pitcher_k_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_form')::numeric, 0)         AS s_pitcher_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_lineup_k')::numeric, 0)    AS s_opposing_lineup_k,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitch_count_trend')::numeric, 0)    AS s_pitch_count_trend,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_rest_pitcher')::numeric, 0)         AS s_rest_pitcher,
  -- Shared (handedness: pitcher + batter; ballpark/weather: pitcher + batter + game; umpire: pitcher + game)
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_handedness_matchup')::numeric, 0)   AS s_handedness_matchup,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_ballpark_factor')::numeric, 0)      AS s_ballpark_factor,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_wind')::numeric, 0)         AS s_weather_wind,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_temp')::numeric, 0)         AS s_weather_temp,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_umpire_k_zone')::numeric, 0)        AS s_umpire_k_zone,
  -- Batter-only
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_hit_rate')::numeric, 0)      AS s_batter_hit_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form')::numeric, 0)          AS s_batter_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_pitcher_quality')::numeric, 0) AS s_opposing_pitcher_quality,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_at_bats')::numeric, 0)       AS s_recent_at_bats,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_consistency')::numeric, 0)   AS s_lineup_consistency,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_power_rate')::numeric, 0)    AS s_batter_power_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form_power')::numeric, 0)    AS s_batter_form_power,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_rate')::numeric, 0)      AS s_pitcher_hr_rate,
  -- Game-only
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_offense_differential')::numeric, 0) AS s_offense_differential,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitching_matchup')::numeric, 0)     AS s_pitching_matchup,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_bullpen_strength')::numeric, 0)     AS s_bullpen_strength,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_run_diff')::numeric, 0)      AS s_recent_run_diff,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_h2h_recent')::numeric, 0)           AS s_h2h_recent,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_team_form')::numeric, 0)            AS s_team_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_vs_hand_split')::numeric, 0) AS s_lineup_vs_hand_split

FROM public.pick_history
WHERE backfill_run_id IN (
  '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',
  '949a88e7-1c20-43e9-a674-ef90e9035f8b',
  'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',
  '61ff4c15-4678-4691-865c-264712fed0ca'
)
  AND hit IS NOT NULL
  AND ai_analysis IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_d366_fs_run_id    ON public.d366_factor_scores (backfill_run_id);
CREATE INDEX IF NOT EXISTS idx_d366_fs_prop_type ON public.d366_factor_scores (prop_type);
GRANT SELECT ON public.d366_factor_scores TO service_role, authenticated;

-- ============================================================
-- d366_score_at_weights — market-aware confidence recompute
-- ============================================================
-- p_weights:         trial point (JSONB { w_mlb_pitcher_k_rate: 1.75, ... })
-- p_current_weights: state on disk (JSONB { w_mlb_pitcher_k_rate: 1.5,  ... })
-- p_min_conf:        threshold for objective_n / objective_hits
--
-- Confidence math: stored confidence already has weights baked in via
--   score_X = round(f_X_raw * current_w_X)
-- Rescale to new_w_X:
--   new_score_X = score_X * (new_w_X / current_w_X)
-- Delta added to stored confidence:
--   score_X * (new_w_X / current_w_X - 1)
-- For shared score_keys (handedness, ballpark, weather_wind, weather_temp, umpire),
-- market routing picks the correct weight column per prop_type.
-- ============================================================
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

        -- ===== 13 D-362 weights (universal — current=1.0 by D-362 init) =====
        + s_pitcher_xera_edge           * (((p_weights ->> 'w_mlb_pitcher_xera_edge')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_pitcher_xera_edge')::numeric, 0))           - 1)
        + s_pitcher_baa                  * (((p_weights ->> 'w_mlb_pitcher_baa')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_pitcher_baa')::numeric, 0))                 - 1)
        + s_catcher_framing              * (((p_weights ->> 'w_mlb_catcher_framing')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_catcher_framing')::numeric, 0))             - 1)
        + s_pitcher_pitch_mix_k          * (((p_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric, 0))         - 1)
        + s_batter_xba                   * (((p_weights ->> 'w_mlb_batter_xba')::numeric                  / NULLIF((p_current_weights ->> 'w_mlb_batter_xba')::numeric, 0))                  - 1)
        + s_batter_exit_velo_trend       * (((p_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric, 0))      - 1)
        + s_batter_barrel_rate           * (((p_weights ->> 'w_mlb_batter_barrel_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_batter_barrel_rate')::numeric, 0))          - 1)
        + s_batter_xslg_regression       * (((p_weights ->> 'w_mlb_batter_xslg_regression')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_xslg_regression')::numeric, 0))      - 1)
        + s_batter_babip                 * (((p_weights ->> 'w_mlb_batter_babip')::numeric                / NULLIF((p_current_weights ->> 'w_mlb_batter_babip')::numeric, 0))                - 1)
        + s_batter_vs_pitcher_hand_split * (((p_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric/ NULLIF((p_current_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric, 0))- 1)
        + s_bullpen_quality              * (((p_weights ->> 'w_mlb_bullpen_quality')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_bullpen_quality')::numeric, 0))             - 1)
        + s_wind_direction_hr            * (((p_weights ->> 'w_mlb_wind_direction_hr')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_wind_direction_hr')::numeric, 0))           - 1)
        + s_pitcher_hr_per_9             * (((p_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric, 0))            - 1)

        -- ===== 10 D-340 PITCHER weights (only apply when prop_type pitcher_strikeouts/pitcher_k) =====
        + CASE WHEN prop_type IN ('pitcher_strikeouts', 'pitcher_k') THEN
              s_pitcher_k_rate       * (((p_weights ->> 'w_mlb_pitcher_k_rate')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_pitcher_k_rate')::numeric, 0))          - 1)
            + s_pitcher_form         * (((p_weights ->> 'w_mlb_pitcher_form')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_pitcher_form')::numeric, 0))            - 1)
            + s_opposing_lineup_k    * (((p_weights ->> 'w_mlb_opposing_lineup_k')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_opposing_lineup_k')::numeric, 0))       - 1)
            + s_handedness_matchup   * (((p_weights ->> 'w_mlb_handedness_matchup')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_handedness_matchup')::numeric, 0))      - 1)
            + s_pitch_count_trend    * (((p_weights ->> 'w_mlb_pitch_count_trend')::numeric       / NULLIF((p_current_weights ->> 'w_mlb_pitch_count_trend')::numeric, 0))       - 1)
            + s_rest_pitcher         * (((p_weights ->> 'w_mlb_rest_pitcher')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_rest_pitcher')::numeric, 0))            - 1)
            + s_ballpark_factor      * (((p_weights ->> 'w_mlb_pitcher_ballpark_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_pitcher_ballpark_factor')::numeric, 0)) - 1)
            + s_weather_wind         * (((p_weights ->> 'w_mlb_pitcher_weather_wind')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_wind')::numeric, 0))    - 1)
            + s_weather_temp         * (((p_weights ->> 'w_mlb_pitcher_weather_temp')::numeric    / NULLIF((p_current_weights ->> 'w_mlb_pitcher_weather_temp')::numeric, 0))    - 1)
            + s_umpire_k_zone        * (((p_weights ->> 'w_mlb_pitcher_umpire_k_zone')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_pitcher_umpire_k_zone')::numeric, 0))   - 1)
          ELSE 0 END

        -- ===== 12 D-340 BATTER weights (batter_* prop_types) =====
        + CASE WHEN prop_type LIKE 'batter_%' OR prop_type IN ('hits','home_runs','total_bases','rbi','rbis','hr','tb') THEN
              s_batter_hit_rate            * (((p_weights ->> 'w_mlb_batter_hit_rate')::numeric             / NULLIF((p_current_weights ->> 'w_mlb_batter_hit_rate')::numeric, 0))             - 1)
            + s_batter_form                * (((p_weights ->> 'w_mlb_batter_form')::numeric                 / NULLIF((p_current_weights ->> 'w_mlb_batter_form')::numeric, 0))                 - 1)
            + s_opposing_pitcher_quality   * (((p_weights ->> 'w_mlb_batter_pitcher_quality')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_quality')::numeric, 0))      - 1)
            + s_recent_at_bats             * (((p_weights ->> 'w_mlb_batter_recent_ab')::numeric            / NULLIF((p_current_weights ->> 'w_mlb_batter_recent_ab')::numeric, 0))            - 1)
            + s_handedness_matchup         * (((p_weights ->> 'w_mlb_batter_handedness_matchup')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_handedness_matchup')::numeric, 0))   - 1)
            + s_ballpark_factor            * (((p_weights ->> 'w_mlb_batter_ballpark_hits_factor')::numeric / NULLIF((p_current_weights ->> 'w_mlb_batter_ballpark_hits_factor')::numeric, 0)) - 1)
            + s_weather_temp               * (((p_weights ->> 'w_mlb_batter_weather_temp')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_temp')::numeric, 0))         - 1)
            + s_lineup_consistency         * (((p_weights ->> 'w_mlb_batter_lineup_consistency')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_batter_lineup_consistency')::numeric, 0))   - 1)
            + s_batter_power_rate          * (((p_weights ->> 'w_mlb_batter_power_rate')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_power_rate')::numeric, 0))           - 1)
            + s_batter_form_power          * (((p_weights ->> 'w_mlb_batter_form_power')::numeric           / NULLIF((p_current_weights ->> 'w_mlb_batter_form_power')::numeric, 0))           - 1)
            + s_pitcher_hr_rate            * (((p_weights ->> 'w_mlb_batter_pitcher_hr_rate')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_batter_pitcher_hr_rate')::numeric, 0))      - 1)
            + s_weather_wind               * (((p_weights ->> 'w_mlb_batter_weather_wind')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_batter_weather_wind')::numeric, 0))         - 1)
          ELSE 0 END

        -- ===== 11 D-340 GAME weights (h2h/moneyline/spreads/runline/totals) =====
        + CASE WHEN prop_type IN ('h2h','moneyline','spreads','runline','totals','total') THEN
              s_offense_differential   * (((p_weights ->> 'w_mlb_game_offense_diff')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_offense_diff')::numeric, 0))      - 1)
            + s_pitching_matchup       * (((p_weights ->> 'w_mlb_game_pitching_matchup')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_pitching_matchup')::numeric, 0))  - 1)
            + s_bullpen_strength       * (((p_weights ->> 'w_mlb_game_bullpen_strength')::numeric  / NULLIF((p_current_weights ->> 'w_mlb_game_bullpen_strength')::numeric, 0))  - 1)
            + s_recent_run_diff        * (((p_weights ->> 'w_mlb_game_recent_run_diff')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_game_recent_run_diff')::numeric, 0))   - 1)
            + s_h2h_recent             * (((p_weights ->> 'w_mlb_game_h2h_recent')::numeric        / NULLIF((p_current_weights ->> 'w_mlb_game_h2h_recent')::numeric, 0))        - 1)
            + s_team_form              * (((p_weights ->> 'w_mlb_game_team_form')::numeric         / NULLIF((p_current_weights ->> 'w_mlb_game_team_form')::numeric, 0))         - 1)
            + s_ballpark_factor        * (((p_weights ->> 'w_mlb_game_ballpark')::numeric          / NULLIF((p_current_weights ->> 'w_mlb_game_ballpark')::numeric, 0))          - 1)
            + s_weather_wind           * (((p_weights ->> 'w_mlb_game_weather_wind')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_wind')::numeric, 0))      - 1)
            + s_weather_temp           * (((p_weights ->> 'w_mlb_game_weather_temp')::numeric      / NULLIF((p_current_weights ->> 'w_mlb_game_weather_temp')::numeric, 0))      - 1)
            + s_umpire_k_zone          * (((p_weights ->> 'w_mlb_game_umpire_k_zone')::numeric     / NULLIF((p_current_weights ->> 'w_mlb_game_umpire_k_zone')::numeric, 0))     - 1)
            + s_lineup_vs_hand_split   * (((p_weights ->> 'w_mlb_lineup_vs_hand_split')::numeric   / NULLIF((p_current_weights ->> 'w_mlb_lineup_vs_hand_split')::numeric, 0))   - 1)
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

GRANT EXECUTE ON FUNCTION public.d366_score_at_weights(jsonb, jsonb, int) TO service_role, authenticated;
