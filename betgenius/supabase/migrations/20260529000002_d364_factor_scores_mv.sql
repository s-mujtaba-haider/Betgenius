-- D-364 SHIP 1c — materialized view of factor scores.
-- JSON parse happens ONCE per row at MV build, not per optimization trial.
-- Rollback: DROP MATERIALIZED VIEW IF EXISTS public.d364_factor_scores;

DROP MATERIALIZED VIEW IF EXISTS public.d364_factor_scores;

CREATE MATERIALIZED VIEW public.d364_factor_scores AS
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
  COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_per_9')::numeric, 0)             AS s_pitcher_hr_per_9
FROM public.pick_history
WHERE backfill_run_id IN (
  '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',
  '949a88e7-1c20-43e9-a674-ef90e9035f8b',
  'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',
  '61ff4c15-4678-4691-865c-264712fed0ca'
)
  AND hit IS NOT NULL
  AND ai_analysis IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_d364_fs_run_id ON public.d364_factor_scores (backfill_run_id);
GRANT SELECT ON public.d364_factor_scores TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.d364_score_at_weights(p_weights JSONB, p_min_conf INT DEFAULT 60)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result JSONB;
BEGIN
  WITH recomputed AS (
    SELECT hit,
      confidence +
        s_pitcher_xera_edge           * ((p_weights ->> 'w_mlb_pitcher_xera_edge')::numeric - 1) +
        s_pitcher_baa                  * ((p_weights ->> 'w_mlb_pitcher_baa')::numeric - 1) +
        s_catcher_framing              * ((p_weights ->> 'w_mlb_catcher_framing')::numeric - 1) +
        s_pitcher_pitch_mix_k          * ((p_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric - 1) +
        s_batter_xba                   * ((p_weights ->> 'w_mlb_batter_xba')::numeric - 1) +
        s_batter_exit_velo_trend       * ((p_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric - 1) +
        s_batter_barrel_rate           * ((p_weights ->> 'w_mlb_batter_barrel_rate')::numeric - 1) +
        s_batter_xslg_regression       * ((p_weights ->> 'w_mlb_batter_xslg_regression')::numeric - 1) +
        s_batter_babip                 * ((p_weights ->> 'w_mlb_batter_babip')::numeric - 1) +
        s_batter_vs_pitcher_hand_split * ((p_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric - 1) +
        s_bullpen_quality              * ((p_weights ->> 'w_mlb_bullpen_quality')::numeric - 1) +
        s_wind_direction_hr            * ((p_weights ->> 'w_mlb_wind_direction_hr')::numeric - 1) +
        s_pitcher_hr_per_9             * ((p_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric - 1)
        AS new_conf
    FROM public.d364_factor_scores
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
