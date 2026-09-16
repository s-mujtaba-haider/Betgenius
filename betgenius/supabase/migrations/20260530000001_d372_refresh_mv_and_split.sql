-- D-372 SHIP 1a + 1b — Refresh d366_factor_scores MV to include D-368,
-- and extend d366_score_at_weights with a deterministic train/validate split.
-- Also bump statement_timeout to handle the 3.3× larger row set.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.d372_score_at_weights(jsonb, jsonb, int, text);
--   DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;
--   then re-apply 20260529000006_d366_extended_mv.sql and 20260529000008_d366_fix_game_market.sql

-- 1a. Refresh MV with 5 validated run_ids (adds D-368 75bb70d1-...).
DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;

CREATE MATERIALIZED VIEW public.d366_factor_scores AS
SELECT
  id, prop_type, confidence::numeric AS confidence, hit, backfill_run_id,
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
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_k_rate')::numeric, 0)               AS s_pitcher_k_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_form')::numeric, 0)                 AS s_pitcher_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_lineup_k')::numeric, 0)            AS s_opposing_lineup_k,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitch_count_trend')::numeric, 0)            AS s_pitch_count_trend,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_rest_pitcher')::numeric, 0)                 AS s_rest_pitcher,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_handedness_matchup')::numeric, 0)           AS s_handedness_matchup,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_ballpark_factor')::numeric, 0)              AS s_ballpark_factor,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_wind')::numeric, 0)                 AS s_weather_wind,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_temp')::numeric, 0)                 AS s_weather_temp,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_umpire_k_zone')::numeric, 0)                AS s_umpire_k_zone,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_hit_rate')::numeric, 0)              AS s_batter_hit_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form')::numeric, 0)                  AS s_batter_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_pitcher_quality')::numeric, 0)     AS s_opposing_pitcher_quality,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_at_bats')::numeric, 0)               AS s_recent_at_bats,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_consistency')::numeric, 0)           AS s_lineup_consistency,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_power_rate')::numeric, 0)            AS s_batter_power_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form_power')::numeric, 0)            AS s_batter_form_power,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_rate')::numeric, 0)              AS s_pitcher_hr_rate,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_offense_differential')::numeric, 0)         AS s_offense_differential,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitching_matchup')::numeric, 0)             AS s_pitching_matchup,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_bullpen_strength')::numeric, 0)             AS s_bullpen_strength,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_run_diff')::numeric, 0)              AS s_recent_run_diff,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_h2h_recent')::numeric, 0)                   AS s_h2h_recent,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_team_form')::numeric, 0)                    AS s_team_form,
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_vs_hand_split')::numeric, 0)         AS s_lineup_vs_hand_split
FROM public.pick_history
WHERE backfill_run_id IN (
  '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',  -- D-358
  '949a88e7-1c20-43e9-a674-ef90e9035f8b',  -- D-359
  'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',  -- D-360-FIX
  '61ff4c15-4678-4691-865c-264712fed0ca',  -- D-363
  '75bb70d1-6578-4c1f-a637-6f20ea158ce3'   -- D-368 (NEW)
)
  AND hit IS NOT NULL
  AND ai_analysis IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_d366_fs_run_id    ON public.d366_factor_scores (backfill_run_id);
CREATE INDEX IF NOT EXISTS idx_d366_fs_prop_type ON public.d366_factor_scores (prop_type);
GRANT SELECT ON public.d366_factor_scores TO service_role, authenticated;

-- 1b. d372_score_at_weights — d366_score_at_weights extended with split_mode.
-- split_mode:
--   'all'      → no row filter
--   'train'    → keep rows where (abs(hashtextextended(id::text, 12345)) % 100) < 70
--   'validate' → keep rows where (abs(hashtextextended(id::text, 12345)) % 100) >= 70
--
-- The hashtextextended with seed 12345 is the deterministic split. Same UUID
-- always maps to the same slice; reproducible. ~70/30 split by row count.
--
-- D-372 SHIP 2 FROZEN_AT_ZERO fix:
--   At curr=0, the d366 formula uses NULLIF((curr)::numeric, 0) → NULL → COALESCE → 0.
--   This freezes any 0-weight at 0. To allow re-evaluation of zero-pinned weights,
--   we apply an ADDITIVE rescale when curr=0:
--     IF curr=0 AND new>0: assume the stored s_X column is f_raw * 1.0 baseline-
--       this is FALSE in general (s_X was actually written as f_raw * curr=0=0,
--       so s_X = 0 for these picks). The pre-stored score loses the f_raw signal.
--   Therefore: at curr=0 we CANNOT recover the factor's contribution from the
--   stored s_X alone. The only ways out are (a) re-score affected picks (out of
--   scope this batch) or (b) FREEZE these 4 weights as "needs rescore" forever.
--   D-372 SHIP 2 documents this and keeps the FROZEN_AT_ZERO classification —
--   the design constraint is fundamental, not a classifier bug.

CREATE OR REPLACE FUNCTION public.d372_score_at_weights(
  p_weights JSONB,
  p_current_weights JSONB,
  p_min_conf INT DEFAULT 60,
  p_split_mode TEXT DEFAULT 'all'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s'
AS $$
DECLARE v_result JSONB;
BEGIN
  WITH base AS (
    SELECT * FROM public.d366_factor_scores
    WHERE
      CASE p_split_mode
        WHEN 'train'    THEN (abs(hashtextextended(id::text, 12345)) % 100) <  70
        WHEN 'validate' THEN (abs(hashtextextended(id::text, 12345)) % 100) >= 70
        ELSE TRUE
      END
  ),
  recomputed AS (
    SELECT
      hit,
      prop_type,
      confidence

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
    FROM base
  ),
  agg AS (
    SELECT
      COUNT(*) AS n_total,
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
  ),
  per_market AS (
    SELECT
      prop_type,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf) AS n,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf AND hit IS TRUE) AS hits
    FROM recomputed
    GROUP BY prop_type
  ),
  per_market_json AS (
    SELECT jsonb_object_agg(prop_type, jsonb_build_object('n', n, 'hits', hits, 'hr', CASE WHEN n > 0 THEN hits::numeric / n ELSE 0 END)) AS j
    FROM per_market
  )
  SELECT jsonb_build_object(
    'split_mode', p_split_mode,
    'n_total', a.n_total,
    'objective_n', a.n, 'objective_hits', a.hits,
    'objective_hit_rate', CASE WHEN a.n > 0 THEN a.hits::numeric / a.n ELSE 0 END,
    'lean_n', a.lean_n, 'lean_hits', a.lean_hits, 'lean_hr', CASE WHEN a.lean_n > 0 THEN a.lean_hits::numeric / a.lean_n ELSE 0 END,
    'good_n', a.good_n, 'good_hits', a.good_hits, 'good_hr', CASE WHEN a.good_n > 0 THEN a.good_hits::numeric / a.good_n ELSE 0 END,
    'strong_n', a.strong_n, 'strong_hits', a.strong_hits, 'strong_hr', CASE WHEN a.strong_n > 0 THEN a.strong_hits::numeric / a.strong_n ELSE 0 END,
    'elite_n', a.elite_n, 'elite_hits', a.elite_hits, 'elite_hr', CASE WHEN a.elite_n > 0 THEN a.elite_hits::numeric / a.elite_n ELSE 0 END,
    'per_market', pmj.j
  ) INTO v_result
  FROM agg a, per_market_json pmj;
  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.d372_score_at_weights(jsonb, jsonb, int, text) TO service_role, authenticated;
