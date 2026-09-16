-- ML Optimizer Upgrade Phase 2 — multi-weight adaptive search (May 7, 2026 evening).
--
-- Two-pass coordinate descent expansion:
--   PASS 1: single-weight wide search across 23 weights × 8 step values
--           = 184 scenarios. Captures every reasonable single-weight
--           perturbation. Results ranked by win_pct improvement.
--   PASS 2: pairwise search restricted to top-5 most-improving single
--           weights. C(5,2)=10 pairs × 4 step-direction combinations
--           = 40 scenarios. Catches pair interactions that single-weight
--           descent misses.
--
-- Total: 224 scenarios per cycle. At ~0.4-0.5s per backtest call,
-- expected wall clock ~90-120s — fits inside 150s edge function ceiling.
--
-- Step values: ±0.25, ±0.5, ±0.75, ±1.0 (8 values per weight in Pass 1).
-- Pass 2 uses ±0.5 only per weight (4 direction combinations per pair).
--
-- Adaptive logic: top-5 selection from Pass 1 ensures Pass 2 explores
-- the most signal-bearing weights. Blind spot: weak-single but strong-
-- pair weights won't make top-5. Mitigation TBD if walk-forward shows
-- proposals consistently miss real pair effects.
--
-- DOES NOT include walk-forward validation — that's Phase 4's wrapper.
-- This function takes optional date-range params; when use_windowed=true
-- it routes through backtest_weights_v3_synthetic_windowed (Phase 1) and
-- can be used standalone or composed by Phase 4's walk-forward function.
--
-- Per session constraints:
--   - ADDITIVE only — old optimize_weights_synthetic_run stays live
--   - DO NOT modify auto_optimize_weights, backtest_weights_v3, or
--     apply_optimized_weights_with_gate
--   - DO NOT route through any apply_*_with_gate function — this returns
--     the proposal, doesn't apply it. Phase 4 will wrap and validate.

CREATE OR REPLACE FUNCTION optimize_weights_multi_weight(
  threshold INTEGER DEFAULT 70,
  use_windowed BOOLEAN DEFAULT false,
  train_start DATE DEFAULT NULL,
  train_end DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  cur RECORD;
  current_weights JSONB;
  baseline_wr NUMERIC;
  baseline_picks BIGINT;
  weight_keys TEXT[] := ARRAY[
    'w_l5','w_l10','w_season','w_floor_ceiling','w_recent_form',
    'w_home_away','w_rest','w_b2b','w_minutes_trend','w_pace',
    'w_opp_defense','w_prop_type','w_z_score','w_role_change',
    'w_vig_filter','w_usg_rate','w_regression','w_market_conf',
    'w_ha_split','w_minutes_floor','w_consistency','w_stale_data',
    'w_player_injury'
  ];
  step_values NUMERIC[] := ARRAY[-1.0, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1.0];
  k TEXT; step_val NUMERIC;
  cur_val NUMERIC; new_val NUMERIC; test_proposal JSONB;
  test_wr NUMERIC; test_picks BIGINT;
  -- Tracking
  pass1_results JSONB := '[]'::JSONB;
  pass2_results JSONB := '[]'::JSONB;
  best_proposal JSONB := NULL;
  best_wr NUMERIC := -1000;
  best_pass TEXT := NULL;
  best_descriptor TEXT := NULL;
  -- Pass 1 best per weight (for top-5 selection)
  per_weight_best_wr NUMERIC;
  per_weight_best_step NUMERIC;
  iter_count INTEGER := 0;
BEGIN
  -- Validate windowed-mode params
  IF use_windowed AND (train_start IS NULL OR train_end IS NULL) THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'use_windowed=true requires both train_start and train_end'
    );
  END IF;

  -- Read current weights
  SELECT * INTO cur FROM algorithm_weights WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'algorithm_weights id=1 not found');
  END IF;

  current_weights := jsonb_build_object(
    'w_l5', cur.w_l5, 'w_l10', cur.w_l10, 'w_season', cur.w_season,
    'w_floor_ceiling', cur.w_floor_ceiling, 'w_recent_form', cur.w_recent_form,
    'w_home_away', cur.w_home_away, 'w_rest', cur.w_rest, 'w_b2b', cur.w_b2b,
    'w_minutes_trend', cur.w_minutes_trend, 'w_pace', cur.w_pace,
    'w_opp_defense', cur.w_opp_defense, 'w_prop_type', cur.w_prop_type,
    'w_z_score', cur.w_z_score, 'w_role_change', cur.w_role_change,
    'w_vig_filter', cur.w_vig_filter, 'w_usg_rate', cur.w_usg_rate,
    'w_regression', cur.w_regression, 'w_market_conf', cur.w_market_conf,
    'w_ha_split', cur.w_ha_split, 'w_minutes_floor', cur.w_minutes_floor,
    'w_consistency', cur.w_consistency, 'w_stale_data', cur.w_stale_data,
    'w_player_injury', cur.w_player_injury
  );

  -- Baseline backtest at threshold using current weights
  IF use_windowed THEN
    SELECT win_pct, picks INTO baseline_wr, baseline_picks
    FROM backtest_weights_v3_synthetic_windowed(
      train_start, train_end,
      cur.w_l5, cur.w_l10, cur.w_season, cur.w_floor_ceiling, cur.w_recent_form,
      cur.w_home_away, cur.w_rest, cur.w_b2b, cur.w_minutes_trend, cur.w_pace,
      cur.w_opp_defense, cur.w_prop_type, cur.w_z_score, cur.w_role_change,
      cur.w_vig_filter, cur.w_usg_rate, cur.w_regression, cur.w_market_conf,
      cur.w_ha_split, cur.w_minutes_floor, cur.w_consistency, cur.w_stale_data,
      cur.w_player_injury, true
    ) WHERE backtest_weights_v3_synthetic_windowed.threshold = optimize_weights_multi_weight.threshold
    LIMIT 1;
  ELSE
    SELECT win_pct, picks INTO baseline_wr, baseline_picks
    FROM backtest_weights_v3_synthetic(
      cur.w_l5, cur.w_l10, cur.w_season, cur.w_floor_ceiling, cur.w_recent_form,
      cur.w_home_away, cur.w_rest, cur.w_b2b, cur.w_minutes_trend, cur.w_pace,
      cur.w_opp_defense, cur.w_prop_type, cur.w_z_score, cur.w_role_change,
      cur.w_vig_filter, cur.w_usg_rate, cur.w_regression, cur.w_market_conf,
      cur.w_ha_split, cur.w_minutes_floor, cur.w_consistency, cur.w_stale_data,
      cur.w_player_injury
    ) WHERE backtest_weights_v3_synthetic.threshold = optimize_weights_multi_weight.threshold
    LIMIT 1;
  END IF;

  IF baseline_wr IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'no synthetic picks at threshold ' || threshold,
      'baseline_picks', COALESCE(baseline_picks, 0)
    );
  END IF;

  best_wr := baseline_wr;

  -- ============================================================
  -- PASS 1: single-weight wide search
  -- 23 weights × 8 step values = 184 scenarios
  -- ============================================================
  FOREACH k IN ARRAY weight_keys LOOP
    per_weight_best_wr := baseline_wr;
    per_weight_best_step := 0;
    cur_val := (current_weights->>k)::NUMERIC;

    FOREACH step_val IN ARRAY step_values LOOP
      iter_count := iter_count + 1;
      new_val := GREATEST(0, cur_val + step_val);
      -- Skip identical proposals (clamping at 0 can produce duplicates
      -- when cur_val + step_val < 0; e.g., w_pace=0 with step -0.25
      -- gives same as cur_val=0).
      IF new_val = cur_val THEN
        CONTINUE;
      END IF;
      test_proposal := jsonb_set(current_weights, ARRAY[k], to_jsonb(new_val));

      IF use_windowed THEN
        SELECT win_pct, picks INTO test_wr, test_picks
        FROM backtest_weights_v3_synthetic_windowed(
          train_start, train_end,
          (test_proposal->>'w_l5')::NUMERIC,
          (test_proposal->>'w_l10')::NUMERIC,
          (test_proposal->>'w_season')::NUMERIC,
          (test_proposal->>'w_floor_ceiling')::NUMERIC,
          (test_proposal->>'w_recent_form')::NUMERIC,
          (test_proposal->>'w_home_away')::NUMERIC,
          (test_proposal->>'w_rest')::NUMERIC,
          (test_proposal->>'w_b2b')::NUMERIC,
          (test_proposal->>'w_minutes_trend')::NUMERIC,
          (test_proposal->>'w_pace')::NUMERIC,
          (test_proposal->>'w_opp_defense')::NUMERIC,
          (test_proposal->>'w_prop_type')::NUMERIC,
          (test_proposal->>'w_z_score')::NUMERIC,
          (test_proposal->>'w_role_change')::NUMERIC,
          (test_proposal->>'w_vig_filter')::NUMERIC,
          (test_proposal->>'w_usg_rate')::NUMERIC,
          (test_proposal->>'w_regression')::NUMERIC,
          (test_proposal->>'w_market_conf')::NUMERIC,
          (test_proposal->>'w_ha_split')::NUMERIC,
          (test_proposal->>'w_minutes_floor')::NUMERIC,
          (test_proposal->>'w_consistency')::NUMERIC,
          (test_proposal->>'w_stale_data')::NUMERIC,
          (test_proposal->>'w_player_injury')::NUMERIC,
          true
        ) WHERE backtest_weights_v3_synthetic_windowed.threshold = optimize_weights_multi_weight.threshold
        LIMIT 1;
      ELSE
        SELECT win_pct, picks INTO test_wr, test_picks
        FROM backtest_weights_v3_synthetic(
          (test_proposal->>'w_l5')::NUMERIC,
          (test_proposal->>'w_l10')::NUMERIC,
          (test_proposal->>'w_season')::NUMERIC,
          (test_proposal->>'w_floor_ceiling')::NUMERIC,
          (test_proposal->>'w_recent_form')::NUMERIC,
          (test_proposal->>'w_home_away')::NUMERIC,
          (test_proposal->>'w_rest')::NUMERIC,
          (test_proposal->>'w_b2b')::NUMERIC,
          (test_proposal->>'w_minutes_trend')::NUMERIC,
          (test_proposal->>'w_pace')::NUMERIC,
          (test_proposal->>'w_opp_defense')::NUMERIC,
          (test_proposal->>'w_prop_type')::NUMERIC,
          (test_proposal->>'w_z_score')::NUMERIC,
          (test_proposal->>'w_role_change')::NUMERIC,
          (test_proposal->>'w_vig_filter')::NUMERIC,
          (test_proposal->>'w_usg_rate')::NUMERIC,
          (test_proposal->>'w_regression')::NUMERIC,
          (test_proposal->>'w_market_conf')::NUMERIC,
          (test_proposal->>'w_ha_split')::NUMERIC,
          (test_proposal->>'w_minutes_floor')::NUMERIC,
          (test_proposal->>'w_consistency')::NUMERIC,
          (test_proposal->>'w_stale_data')::NUMERIC,
          (test_proposal->>'w_player_injury')::NUMERIC
        ) WHERE backtest_weights_v3_synthetic.threshold = optimize_weights_multi_weight.threshold
        LIMIT 1;
      END IF;

      IF test_wr IS NOT NULL AND test_wr > best_wr THEN
        best_wr := test_wr;
        best_proposal := test_proposal;
        best_pass := 'pass1';
        best_descriptor := k || ' ' || (CASE WHEN step_val > 0 THEN '+' ELSE '' END) || step_val;
      END IF;

      IF test_wr IS NOT NULL AND test_wr > per_weight_best_wr THEN
        per_weight_best_wr := test_wr;
        per_weight_best_step := step_val;
      END IF;
    END LOOP;

    -- Record this weight's best result for Pass 2 top-5 selection
    pass1_results := pass1_results || jsonb_build_object(
      'weight_key', k,
      'best_wr', per_weight_best_wr,
      'best_step', per_weight_best_step,
      'delta_pp', per_weight_best_wr - baseline_wr
    );
  END LOOP;

  -- ============================================================
  -- PASS 2: pair search on top-5 most-improving weights
  -- C(5, 2) = 10 pairs × 4 direction combinations (each at ±0.5)
  -- = 40 scenarios
  -- ============================================================
  DECLARE
    top5 TEXT[];
    pair_a TEXT; pair_b TEXT;
    a_step NUMERIC; b_step NUMERIC;
    a_val NUMERIC; b_val NUMERIC; new_a_val NUMERIC; new_b_val NUMERIC;
    pair_signs NUMERIC[][] := ARRAY[ARRAY[1.0, 1.0], ARRAY[1.0, -1.0], ARRAY[-1.0, 1.0], ARRAY[-1.0, -1.0]];
    sign_pair NUMERIC[];
    PAIR_STEP_MAGNITUDE CONSTANT NUMERIC := 0.5;
  BEGIN
    -- Select top-5 weights by best Pass-1 improvement
    SELECT array_agg(weight_key ORDER BY (delta_pp)::NUMERIC DESC)
    INTO top5
    FROM (
      SELECT
        (elem->>'weight_key')::TEXT AS weight_key,
        (elem->>'delta_pp')::NUMERIC AS delta_pp
      FROM jsonb_array_elements(pass1_results) AS elem
      ORDER BY delta_pp DESC
      LIMIT 5
    ) ranked;

    IF array_length(top5, 1) >= 2 THEN
      -- Iterate unordered pairs of top5
      FOR i IN 1..array_length(top5, 1) - 1 LOOP
        FOR j IN i + 1..array_length(top5, 1) LOOP
          pair_a := top5[i];
          pair_b := top5[j];
          a_val := (current_weights->>pair_a)::NUMERIC;
          b_val := (current_weights->>pair_b)::NUMERIC;

          FOREACH sign_pair SLICE 1 IN ARRAY pair_signs LOOP
            iter_count := iter_count + 1;
            new_a_val := GREATEST(0, a_val + sign_pair[1] * PAIR_STEP_MAGNITUDE);
            new_b_val := GREATEST(0, b_val + sign_pair[2] * PAIR_STEP_MAGNITUDE);
            test_proposal := jsonb_set(
              jsonb_set(current_weights, ARRAY[pair_a], to_jsonb(new_a_val)),
              ARRAY[pair_b], to_jsonb(new_b_val)
            );

            IF use_windowed THEN
              SELECT win_pct INTO test_wr
              FROM backtest_weights_v3_synthetic_windowed(
                train_start, train_end,
                (test_proposal->>'w_l5')::NUMERIC, (test_proposal->>'w_l10')::NUMERIC,
                (test_proposal->>'w_season')::NUMERIC, (test_proposal->>'w_floor_ceiling')::NUMERIC,
                (test_proposal->>'w_recent_form')::NUMERIC, (test_proposal->>'w_home_away')::NUMERIC,
                (test_proposal->>'w_rest')::NUMERIC, (test_proposal->>'w_b2b')::NUMERIC,
                (test_proposal->>'w_minutes_trend')::NUMERIC, (test_proposal->>'w_pace')::NUMERIC,
                (test_proposal->>'w_opp_defense')::NUMERIC, (test_proposal->>'w_prop_type')::NUMERIC,
                (test_proposal->>'w_z_score')::NUMERIC, (test_proposal->>'w_role_change')::NUMERIC,
                (test_proposal->>'w_vig_filter')::NUMERIC, (test_proposal->>'w_usg_rate')::NUMERIC,
                (test_proposal->>'w_regression')::NUMERIC, (test_proposal->>'w_market_conf')::NUMERIC,
                (test_proposal->>'w_ha_split')::NUMERIC, (test_proposal->>'w_minutes_floor')::NUMERIC,
                (test_proposal->>'w_consistency')::NUMERIC, (test_proposal->>'w_stale_data')::NUMERIC,
                (test_proposal->>'w_player_injury')::NUMERIC, true
              ) WHERE backtest_weights_v3_synthetic_windowed.threshold = optimize_weights_multi_weight.threshold
              LIMIT 1;
            ELSE
              SELECT win_pct INTO test_wr
              FROM backtest_weights_v3_synthetic(
                (test_proposal->>'w_l5')::NUMERIC, (test_proposal->>'w_l10')::NUMERIC,
                (test_proposal->>'w_season')::NUMERIC, (test_proposal->>'w_floor_ceiling')::NUMERIC,
                (test_proposal->>'w_recent_form')::NUMERIC, (test_proposal->>'w_home_away')::NUMERIC,
                (test_proposal->>'w_rest')::NUMERIC, (test_proposal->>'w_b2b')::NUMERIC,
                (test_proposal->>'w_minutes_trend')::NUMERIC, (test_proposal->>'w_pace')::NUMERIC,
                (test_proposal->>'w_opp_defense')::NUMERIC, (test_proposal->>'w_prop_type')::NUMERIC,
                (test_proposal->>'w_z_score')::NUMERIC, (test_proposal->>'w_role_change')::NUMERIC,
                (test_proposal->>'w_vig_filter')::NUMERIC, (test_proposal->>'w_usg_rate')::NUMERIC,
                (test_proposal->>'w_regression')::NUMERIC, (test_proposal->>'w_market_conf')::NUMERIC,
                (test_proposal->>'w_ha_split')::NUMERIC, (test_proposal->>'w_minutes_floor')::NUMERIC,
                (test_proposal->>'w_consistency')::NUMERIC, (test_proposal->>'w_stale_data')::NUMERIC,
                (test_proposal->>'w_player_injury')::NUMERIC
              ) WHERE backtest_weights_v3_synthetic.threshold = optimize_weights_multi_weight.threshold
              LIMIT 1;
            END IF;

            pass2_results := pass2_results || jsonb_build_object(
              'pair', pair_a || '+' || pair_b,
              'a_step', sign_pair[1] * PAIR_STEP_MAGNITUDE,
              'b_step', sign_pair[2] * PAIR_STEP_MAGNITUDE,
              'wr', test_wr,
              'delta_pp', COALESCE(test_wr, baseline_wr) - baseline_wr
            );

            IF test_wr IS NOT NULL AND test_wr > best_wr THEN
              best_wr := test_wr;
              best_proposal := test_proposal;
              best_pass := 'pass2';
              best_descriptor := pair_a || ' ' || (CASE WHEN sign_pair[1] > 0 THEN '+' ELSE '' END) ||
                (sign_pair[1] * PAIR_STEP_MAGNITUDE) ||
                ' & ' || pair_b || ' ' || (CASE WHEN sign_pair[2] > 0 THEN '+' ELSE '' END) ||
                (sign_pair[2] * PAIR_STEP_MAGNITUDE);
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
    END IF;
  END;

  -- Build response
  RETURN jsonb_build_object(
    'status', CASE WHEN best_proposal IS NULL THEN 'no_improvement' ELSE 'proposal_found' END,
    'baseline_wr', baseline_wr,
    'baseline_picks', baseline_picks,
    'best_wr', best_wr,
    'delta_pp', best_wr - baseline_wr,
    'iterations', iter_count,
    'best_pass', best_pass,
    'best_descriptor', best_descriptor,
    'best_proposal', best_proposal,
    'pass1_top5', (
      SELECT jsonb_agg(elem ORDER BY (elem->>'delta_pp')::NUMERIC DESC)
      FROM jsonb_array_elements(pass1_results) elem
      WHERE (elem->>'delta_pp')::NUMERIC > 0
      LIMIT 5
    ),
    'pass2_results', pass2_results,
    'use_windowed', use_windowed,
    'train_start', train_start,
    'train_end', train_end,
    'threshold', threshold
  );
END;
$$ LANGUAGE plpgsql;

-- 5-minute statement_timeout — Pass 1 (184 scenarios) + Pass 2 (40
-- scenarios) at ~0.5s each = ~112s total. Headroom for warm-up + slow
-- backtest calls. PostgREST default 8s would clip immediately.
ALTER FUNCTION optimize_weights_multi_weight(INTEGER, BOOLEAN, DATE, DATE)
  SET statement_timeout = '300s';

COMMENT ON FUNCTION optimize_weights_multi_weight IS
  'Multi-weight adaptive search (May 7 ML upgrade Phase 2). Pass 1 = 23 '
  'weights × 8 step variants. Pass 2 = top-5 weights paired × 4 direction '
  'combinations. Returns proposal + descriptor + audit JSON. Does NOT apply '
  'weights — Phase 4 walk-forward wrapper does that. use_windowed=true '
  'routes through Phase-1 windowed backtest variant for walk-forward training.';
