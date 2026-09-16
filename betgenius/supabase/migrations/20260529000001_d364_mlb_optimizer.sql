-- D-364 SHIP 1b — SQL-side MLB optimizer.
--
-- HONEST SCOPE per d364_architecture.md Option A → A':
--   The edge function approach hit WORKER_RESOURCE_LIMIT at full 17K corpus
--   due to JSON parsing memory. Moving the optimizer to a Postgres function
--   that READS stored factor scores from ai_analysis::jsonb. We are NOT
--   re-implementing scoring math in SQL — we read what scoring_mlb_v2.ts
--   already computed and stored. The optimization math is just:
--     new_conf = stored_conf + Σ score_i * (new_w_i - 1.0)
--   over the 13 D-362-wired weights.
--
-- Functions:
--   d364_score_at_weights(weights JSONB, min_conf INT)
--     → JSONB with N / resolved / hits / hit_rate at the given weight set
--
--   d364_optimize_mlb(min_conf INT, min_picks INT, max_passes INT, dry_run BOOL)
--     → coordinate-descent optimizer. Walks each of 13 weights through a
--       fixed grid [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]; picks
--       value maximizing aggregate WR at min_conf; iterates until no
--       changes in a pass OR max_passes hit.
--
-- Safety:
--   - Hard guardrail: any weight outside [0.0, 5.0] → return error
--   - Hard guardrail: ≥5 weights pinned to 0.0 → return error
--   - dry_run=true (default) does NOT mutate algorithm_weights
--   - dry_run=false requires the caller to explicitly opt in
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.d364_score_at_weights(JSONB, INT);
--   DROP FUNCTION IF EXISTS public.d364_optimize_mlb(INT, INT, INT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.d364_score_at_weights(
  p_weights JSONB,
  p_min_conf INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  WITH validated AS (
    SELECT
      confidence,
      hit,
      (ai_analysis::jsonb -> 'factor_breakdown') AS fb
    FROM pick_history
    WHERE backfill_run_id IN (
      '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',
      '949a88e7-1c20-43e9-a674-ef90e9035f8b',
      'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',
      '61ff4c15-4678-4691-865c-264712fed0ca'
    )
    AND hit IS NOT NULL
    AND ai_analysis IS NOT NULL
  ),
  recomputed AS (
    SELECT
      hit,
      confidence +
        COALESCE((fb ->> 'score_pitcher_xera_edge')::numeric, 0)
          * ((p_weights ->> 'w_mlb_pitcher_xera_edge')::numeric - 1) +
        COALESCE((fb ->> 'score_pitcher_baa')::numeric, 0)
          * ((p_weights ->> 'w_mlb_pitcher_baa')::numeric - 1) +
        COALESCE((fb ->> 'score_catcher_framing')::numeric, 0)
          * ((p_weights ->> 'w_mlb_catcher_framing')::numeric - 1) +
        COALESCE((fb ->> 'score_pitcher_pitch_mix_k')::numeric, 0)
          * ((p_weights ->> 'w_mlb_pitcher_pitch_mix_k')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_xba')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_xba')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_exit_velo_trend')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_exit_velo_trend')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_barrel_rate')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_barrel_rate')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_xslg_regression')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_xslg_regression')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_babip')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_babip')::numeric - 1) +
        COALESCE((fb ->> 'score_batter_vs_pitcher_hand_split')::numeric, 0)
          * ((p_weights ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric - 1) +
        COALESCE((fb ->> 'score_bullpen_quality')::numeric, 0)
          * ((p_weights ->> 'w_mlb_bullpen_quality')::numeric - 1) +
        COALESCE((fb ->> 'score_wind_direction_hr')::numeric, 0)
          * ((p_weights ->> 'w_mlb_wind_direction_hr')::numeric - 1) +
        COALESCE((fb ->> 'score_pitcher_hr_per_9')::numeric, 0)
          * ((p_weights ->> 'w_mlb_pitcher_hr_per_9')::numeric - 1)
        AS new_conf
    FROM validated
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
    'objective_n', n,
    'objective_hits', hits,
    'objective_hit_rate', CASE WHEN n > 0 THEN hits::numeric / n ELSE 0 END,
    'lean_n', lean_n, 'lean_hits', lean_hits,
    'lean_hr', CASE WHEN lean_n > 0 THEN lean_hits::numeric / lean_n ELSE 0 END,
    'good_n', good_n, 'good_hits', good_hits,
    'good_hr', CASE WHEN good_n > 0 THEN good_hits::numeric / good_n ELSE 0 END,
    'strong_n', strong_n, 'strong_hits', strong_hits,
    'strong_hr', CASE WHEN strong_n > 0 THEN strong_hits::numeric / strong_n ELSE 0 END,
    'elite_n', elite_n, 'elite_hits', elite_hits,
    'elite_hr', CASE WHEN elite_n > 0 THEN elite_hits::numeric / elite_n ELSE 0 END
  ) INTO v_result
  FROM agg;
  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.d364_score_at_weights(JSONB, INT) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.d364_optimize_mlb(
  p_min_conf INT DEFAULT 60,
  p_min_picks INT DEFAULT 100,
  p_max_passes INT DEFAULT 3,
  p_dry_run BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_weight_keys TEXT[] := ARRAY[
    'w_mlb_pitcher_xera_edge', 'w_mlb_pitcher_baa', 'w_mlb_catcher_framing',
    'w_mlb_pitcher_pitch_mix_k', 'w_mlb_batter_xba', 'w_mlb_batter_exit_velo_trend',
    'w_mlb_batter_barrel_rate', 'w_mlb_batter_xslg_regression', 'w_mlb_batter_babip',
    'w_mlb_batter_vs_pitcher_hand_split', 'w_mlb_bullpen_quality',
    'w_mlb_wind_direction_hr', 'w_mlb_pitcher_hr_per_9'
  ];
  v_grid NUMERIC[] := ARRAY[0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  v_initial JSONB;
  v_current JSONB;
  v_baseline_eval JSONB;
  v_final_eval JSONB;
  v_pass INT;
  v_any_change BOOLEAN;
  v_w TEXT;
  v_v NUMERIC;
  v_eval JSONB;
  v_best_v NUMERIC;
  v_best_wr NUMERIC;
  v_curr_wr NUMERIC;
  v_log JSONB := '[]'::jsonb;
  v_old_val NUMERIC;
  v_pinned_zero INT;
  v_out_of_bounds INT;
  v_apply_status TEXT;
BEGIN
  -- Capture initial weights from algorithm_weights row 1.
  SELECT jsonb_build_object(
    'w_mlb_pitcher_xera_edge',           w_mlb_pitcher_xera_edge,
    'w_mlb_pitcher_baa',                  w_mlb_pitcher_baa,
    'w_mlb_catcher_framing',              w_mlb_catcher_framing,
    'w_mlb_pitcher_pitch_mix_k',          w_mlb_pitcher_pitch_mix_k,
    'w_mlb_batter_xba',                   w_mlb_batter_xba,
    'w_mlb_batter_exit_velo_trend',       w_mlb_batter_exit_velo_trend,
    'w_mlb_batter_barrel_rate',           w_mlb_batter_barrel_rate,
    'w_mlb_batter_xslg_regression',       w_mlb_batter_xslg_regression,
    'w_mlb_batter_babip',                 w_mlb_batter_babip,
    'w_mlb_batter_vs_pitcher_hand_split', w_mlb_batter_vs_pitcher_hand_split,
    'w_mlb_bullpen_quality',              w_mlb_bullpen_quality,
    'w_mlb_wind_direction_hr',            w_mlb_wind_direction_hr,
    'w_mlb_pitcher_hr_per_9',             w_mlb_pitcher_hr_per_9
  ) INTO v_initial
  FROM algorithm_weights WHERE id = 1;

  v_current := v_initial;
  v_baseline_eval := public.d364_score_at_weights(v_initial, p_min_conf);

  -- Coordinate descent
  FOR v_pass IN 0..p_max_passes-1 LOOP
    v_any_change := FALSE;
    FOREACH v_w IN ARRAY v_weight_keys LOOP
      v_curr_wr := (public.d364_score_at_weights(v_current, p_min_conf) ->> 'objective_hit_rate')::numeric;
      v_best_v := (v_current ->> v_w)::numeric;
      v_best_wr := v_curr_wr;
      v_old_val := v_best_v;
      FOREACH v_v IN ARRAY v_grid LOOP
        v_eval := public.d364_score_at_weights(jsonb_set(v_current, ARRAY[v_w], to_jsonb(v_v)), p_min_conf);
        IF ((v_eval ->> 'objective_n')::int >= p_min_picks)
           AND ((v_eval ->> 'objective_hit_rate')::numeric > v_best_wr) THEN
          v_best_wr := (v_eval ->> 'objective_hit_rate')::numeric;
          v_best_v := v_v;
        END IF;
      END LOOP;
      IF v_best_v <> v_old_val THEN
        v_current := jsonb_set(v_current, ARRAY[v_w], to_jsonb(v_best_v));
        v_log := v_log || jsonb_build_object(
          'pass', v_pass, 'weight', v_w, 'old', v_old_val, 'new', v_best_v,
          'wr_pre', v_curr_wr, 'wr_post', v_best_wr
        );
        v_any_change := TRUE;
      END IF;
    END LOOP;
    EXIT WHEN NOT v_any_change;
  END LOOP;

  v_final_eval := public.d364_score_at_weights(v_current, p_min_conf);

  -- Safety check
  v_pinned_zero := 0;
  v_out_of_bounds := 0;
  FOREACH v_w IN ARRAY v_weight_keys LOOP
    v_v := (v_current ->> v_w)::numeric;
    IF v_v < 0 OR v_v > 5 THEN v_out_of_bounds := v_out_of_bounds + 1; END IF;
    IF v_v = 0 THEN v_pinned_zero := v_pinned_zero + 1; END IF;
  END LOOP;

  IF v_out_of_bounds > 0 OR v_pinned_zero >= 5 THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'reason', 'safety_abort',
      'pinned_to_zero', v_pinned_zero,
      'out_of_bounds', v_out_of_bounds,
      'initial_weights', v_initial,
      'proposed_weights', v_current,
      'baseline_eval', v_baseline_eval,
      'final_eval', v_final_eval,
      'pass_log', v_log
    );
  END IF;

  -- Apply if not dry_run
  v_apply_status := 'dry_run';
  IF NOT p_dry_run THEN
    UPDATE algorithm_weights SET
      w_mlb_pitcher_xera_edge           = (v_current ->> 'w_mlb_pitcher_xera_edge')::numeric,
      w_mlb_pitcher_baa                  = (v_current ->> 'w_mlb_pitcher_baa')::numeric,
      w_mlb_catcher_framing              = (v_current ->> 'w_mlb_catcher_framing')::numeric,
      w_mlb_pitcher_pitch_mix_k          = (v_current ->> 'w_mlb_pitcher_pitch_mix_k')::numeric,
      w_mlb_batter_xba                   = (v_current ->> 'w_mlb_batter_xba')::numeric,
      w_mlb_batter_exit_velo_trend       = (v_current ->> 'w_mlb_batter_exit_velo_trend')::numeric,
      w_mlb_batter_barrel_rate           = (v_current ->> 'w_mlb_batter_barrel_rate')::numeric,
      w_mlb_batter_xslg_regression       = (v_current ->> 'w_mlb_batter_xslg_regression')::numeric,
      w_mlb_batter_babip                 = (v_current ->> 'w_mlb_batter_babip')::numeric,
      w_mlb_batter_vs_pitcher_hand_split = (v_current ->> 'w_mlb_batter_vs_pitcher_hand_split')::numeric,
      w_mlb_bullpen_quality              = (v_current ->> 'w_mlb_bullpen_quality')::numeric,
      w_mlb_wind_direction_hr            = (v_current ->> 'w_mlb_wind_direction_hr')::numeric,
      w_mlb_pitcher_hr_per_9             = (v_current ->> 'w_mlb_pitcher_hr_per_9')::numeric
    WHERE id = 1;
    v_apply_status := 'applied';
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'apply_status', v_apply_status,
    'initial_weights', v_initial,
    'proposed_weights', v_current,
    'baseline_eval', v_baseline_eval,
    'final_eval', v_final_eval,
    'delta_wr', (v_final_eval ->> 'objective_hit_rate')::numeric - (v_baseline_eval ->> 'objective_hit_rate')::numeric,
    'pass_log', v_log,
    'pinned_to_zero', v_pinned_zero,
    'out_of_bounds', v_out_of_bounds
  );
END $$;

GRANT EXECUTE ON FUNCTION public.d364_optimize_mlb(INT, INT, INT, BOOLEAN) TO service_role, authenticated;

COMMENT ON FUNCTION public.d364_optimize_mlb(INT, INT, INT, BOOLEAN) IS
  'D-364 T11 first MLB run. Coordinate-descent optimizer over the 13 '
  'D-362-wired MLB weights. Reads stored factor scores from '
  'pick_history.ai_analysis::jsonb. Dry-run by default; pass p_dry_run=FALSE '
  'to actually mutate algorithm_weights.';
