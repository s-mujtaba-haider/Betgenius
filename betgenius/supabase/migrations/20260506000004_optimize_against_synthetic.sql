-- Optimize weights against the 12,497-pick synthetic backfill.
--
-- Per CEO directive (May 6 three-task session, Task 3): run coordinate-
-- descent to find weight perturbations that improve win rate at threshold
-- 70+, filtered to is_synthetic=true picks (the post-megadeploy algorithm
-- × resolved historical outcomes corpus). Routes through a synthetic-aware
-- safety gate. Single manual invocation; cron stays UNSCHEDULED.
--
-- Three new functions, all additive:
--
-- 1. backtest_weights_v3_synthetic(...): copy of backtest_weights_v3 with
--    WHERE clause swapped to filter is_synthetic=true. Existing v3 stays
--    untouched (CEO directive). Same param signature.
--
-- 2. apply_optimized_weights_with_gate_synthetic(...): copy of the existing
--    gate function but calls v3_synthetic for baseline + proposed backtests.
--    Writes to the same safety_gate_log audit table; invoked_by string lets
--    us distinguish synthetic-source rows in the log.
--
-- 3. optimize_weights_synthetic_run(): coordinate-descent driver. Reads
--    current weights, perturbs each of 23 weights ±0.25, runs v3_synthetic
--    for each candidate (46 backtests total), picks the best perturbation
--    by win_pct, routes through gate_synthetic. Returns gate result + best
--    perturbation summary.
--
-- WHY synthetic-only filter for optimization:
--   The 12,497 synthetic picks all scored under the SAME post-megadeploy
--   algorithm × resolved against ground-truth historical outcomes. That's
--   the cleanest signal for tuning factor weights. Mixing in organic
--   post-megadeploy picks (~150-300/day since May 4) gives only ~150-450
--   resolved picks at 70+ — too noisy for meaningful coordinate descent.
--   Synthetic gives ~3000+ at 70+, statistically meaningful.
--
-- WHY gate against synthetic too:
--   The standard gate calls v3 (post-megadeploy organic). For a synthetic-
--   sourced proposal, comparing baseline-on-synthetic vs proposed-on-
--   synthetic is the apples-to-apples check. Mixed comparison (proposed-
--   on-synthetic vs baseline-on-organic) would be invalid.
--
-- Cron schedule: UNSCHEDULED. This migration adds new functions; pg_cron
-- is untouched. CEO calls via SELECT optimize_weights_synthetic_run();

-- ============================================================================
-- Function 1: backtest_weights_v3_synthetic
-- Mirrors backtest_weights_v3 body, with WHERE filter swapped to is_synthetic.
-- ============================================================================
CREATE OR REPLACE FUNCTION backtest_weights_v3_synthetic(
  w_l5 NUMERIC DEFAULT 1.0,             w_l10 NUMERIC DEFAULT 0.75,
  w_season NUMERIC DEFAULT 1.75,        w_floor_ceiling NUMERIC DEFAULT 1.5,
  w_recent_form NUMERIC DEFAULT 1.5,    w_home_away NUMERIC DEFAULT 1.0,
  w_rest NUMERIC DEFAULT 1.0,           w_b2b NUMERIC DEFAULT 2.25,
  w_minutes_trend NUMERIC DEFAULT 0.0,  w_pace NUMERIC DEFAULT 0.5,
  w_opp_defense NUMERIC DEFAULT 0.0,    w_prop_type NUMERIC DEFAULT 0.25,
  w_z_score NUMERIC DEFAULT 0.25,       w_role_change NUMERIC DEFAULT 2.0,
  w_vig_filter NUMERIC DEFAULT 0.5,     w_usg_rate NUMERIC DEFAULT 1.0,
  w_regression NUMERIC DEFAULT 1.0,     w_market_conf NUMERIC DEFAULT 2.0,
  w_ha_split NUMERIC DEFAULT 0.0,       w_minutes_floor NUMERIC DEFAULT 2.5,
  w_consistency NUMERIC DEFAULT 1.0,    w_stale_data NUMERIC DEFAULT 2.25,
  w_player_injury NUMERIC DEFAULT 0.75
)
RETURNS TABLE (
  threshold INTEGER, picks BIGINT, hits BIGINT, win_pct NUMERIC, roi_pct NUMERIC
) AS $$
  WITH scored AS (
    SELECT
      hit, odds, score_trivial_line_cap,
      GREATEST(0, LEAST(100,
        50
        + ROUND(COALESCE(score_l5, 0)::NUMERIC * w_l5)
        + ROUND(COALESCE(score_l10, 0)::NUMERIC * w_l10)
        + ROUND(COALESCE(score_season, 0)::NUMERIC * w_season)
        + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * w_floor_ceiling)
        + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * w_recent_form)
        + ROUND(COALESCE(score_home_away, 0)::NUMERIC * w_home_away)
        + ROUND(COALESCE(score_rest, 0)::NUMERIC * w_rest)
        + ROUND(COALESCE(score_b2b, 0)::NUMERIC * w_b2b)
        + ROUND(COALESCE(score_minutes_trend, 0)::NUMERIC * w_minutes_trend)
        + ROUND(COALESCE(score_pace, 0)::NUMERIC * w_pace)
        + ROUND(COALESCE(score_opp_defense, 0)::NUMERIC * w_opp_defense)
        + ROUND(COALESCE(score_prop_type_penalty, 0)::NUMERIC * w_prop_type)
        + ROUND(COALESCE(score_z_score, 0)::NUMERIC * w_z_score)
        + ROUND(COALESCE(score_role_change, 0)::NUMERIC * w_role_change)
        + ROUND(COALESCE(score_vig_filter, 0)::NUMERIC * w_vig_filter)
        + ROUND(COALESCE(score_usg_rate, 0)::NUMERIC * w_usg_rate)
        + ROUND(COALESCE(score_regression, 0)::NUMERIC * w_regression)
        + ROUND(COALESCE(score_market_conf, 0)::NUMERIC * w_market_conf)
        + ROUND(COALESCE(score_home_away_split, 0)::NUMERIC * w_ha_split)
        + ROUND(COALESCE(score_minutes_volume, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_minutes_stability, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_consistency, 0)::NUMERIC * w_consistency)
        + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * w_stale_data)
        + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * w_player_injury)
        + COALESCE(score_trivial_line_penalty, 0)::NUMERIC
      )) AS raw_reconstructed
    FROM pick_history
    WHERE is_synthetic = true
      AND hit IS NOT NULL
      AND prop_type NOT IN ('spread', 'game_total')
  ),
  capped AS (
    SELECT hit, odds,
      CASE
        WHEN COALESCE(score_trivial_line_cap, false) AND raw_reconstructed > 65 THEN 65
        ELSE raw_reconstructed
      END AS reconstructed_confidence
    FROM scored
  )
  SELECT
    t.threshold::INTEGER,
    COUNT(*)::BIGINT AS picks,
    SUM(CASE WHEN hit THEN 1 ELSE 0 END)::BIGINT AS hits,
    ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS win_pct,
    ROUND(100.0 * SUM(
      CASE WHEN hit THEN
        CASE WHEN odds > 0 THEN odds::NUMERIC ELSE 10000.0 / ABS(odds::NUMERIC) END
      ELSE -100 END
    ) / NULLIF(COUNT(*), 0) / 100, 2) AS roi_pct
  FROM capped
  CROSS JOIN (VALUES (60), (65), (70), (75), (80), (85), (90)) AS t(threshold)
  WHERE reconstructed_confidence >= t.threshold
  GROUP BY t.threshold
  ORDER BY t.threshold;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION backtest_weights_v3_synthetic IS
  'Synthetic-corpus variant of backtest_weights_v3. Filters to is_synthetic=true '
  '(drops the created_at + source filters that would exclude backfill rows). '
  'Adds 60/65 thresholds for finer-grained calibration analysis. Same scoring '
  'arithmetic as v3 — only the WHERE clause differs.';

-- ============================================================================
-- Function 2: apply_optimized_weights_with_gate_synthetic
-- Synthetic-corpus variant of the gate. Same audit table; invoked_by tag
-- distinguishes synthetic-source runs.
-- ============================================================================
CREATE OR REPLACE FUNCTION apply_optimized_weights_with_gate_synthetic(
  proposed_weights JSONB,
  confidence_threshold NUMERIC DEFAULT 70,
  invoked_by TEXT DEFAULT 'optimize_weights_synthetic_run'
)
RETURNS JSONB AS $$
DECLARE
  current_row RECORD;
  baseline_wr NUMERIC;
  proposed_wr NUMERIC;
  baseline_picks BIGINT;
  proposed_picks BIGINT;
  delta_pp NUMERIC;
  status_val TEXT;
  reason_val TEXT;
  audit_id UUID;
  rejection_threshold_pp CONSTANT NUMERIC := 1.0;
  baseline_weights_jsonb JSONB;
  rw_l5 NUMERIC; rw_l10 NUMERIC; rw_season NUMERIC; rw_floor_ceiling NUMERIC;
  rw_recent_form NUMERIC; rw_home_away NUMERIC; rw_rest NUMERIC; rw_b2b NUMERIC;
  rw_minutes_trend NUMERIC; rw_pace NUMERIC; rw_opp_defense NUMERIC;
  rw_prop_type NUMERIC; rw_z_score NUMERIC; rw_role_change NUMERIC;
  rw_vig_filter NUMERIC; rw_usg_rate NUMERIC; rw_regression NUMERIC;
  rw_market_conf NUMERIC; rw_ha_split NUMERIC; rw_minutes_floor NUMERIC;
  rw_consistency NUMERIC; rw_stale_data NUMERIC; rw_player_injury NUMERIC;
BEGIN
  SELECT * INTO current_row FROM algorithm_weights WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'algorithm_weights id=1 not found'; END IF;

  baseline_weights_jsonb := jsonb_build_object(
    'w_l5', current_row.w_l5, 'w_l10', current_row.w_l10,
    'w_season', current_row.w_season, 'w_floor_ceiling', current_row.w_floor_ceiling,
    'w_recent_form', current_row.w_recent_form, 'w_home_away', current_row.w_home_away,
    'w_rest', current_row.w_rest, 'w_b2b', current_row.w_b2b,
    'w_minutes_trend', current_row.w_minutes_trend, 'w_pace', current_row.w_pace,
    'w_opp_defense', current_row.w_opp_defense, 'w_prop_type', current_row.w_prop_type,
    'w_z_score', current_row.w_z_score, 'w_role_change', current_row.w_role_change,
    'w_vig_filter', current_row.w_vig_filter, 'w_usg_rate', current_row.w_usg_rate,
    'w_regression', current_row.w_regression, 'w_market_conf', current_row.w_market_conf,
    'w_ha_split', current_row.w_ha_split, 'w_minutes_floor', current_row.w_minutes_floor,
    'w_consistency', current_row.w_consistency, 'w_stale_data', current_row.w_stale_data,
    'w_player_injury', current_row.w_player_injury
  );

  rw_l5             := COALESCE((proposed_weights->>'w_l5')::NUMERIC, current_row.w_l5);
  rw_l10            := COALESCE((proposed_weights->>'w_l10')::NUMERIC, current_row.w_l10);
  rw_season         := COALESCE((proposed_weights->>'w_season')::NUMERIC, current_row.w_season);
  rw_floor_ceiling  := COALESCE((proposed_weights->>'w_floor_ceiling')::NUMERIC, current_row.w_floor_ceiling);
  rw_recent_form    := COALESCE((proposed_weights->>'w_recent_form')::NUMERIC, current_row.w_recent_form);
  rw_home_away      := COALESCE((proposed_weights->>'w_home_away')::NUMERIC, current_row.w_home_away);
  rw_rest           := COALESCE((proposed_weights->>'w_rest')::NUMERIC, current_row.w_rest);
  rw_b2b            := COALESCE((proposed_weights->>'w_b2b')::NUMERIC, current_row.w_b2b);
  rw_minutes_trend  := COALESCE((proposed_weights->>'w_minutes_trend')::NUMERIC, current_row.w_minutes_trend);
  rw_pace           := COALESCE((proposed_weights->>'w_pace')::NUMERIC, current_row.w_pace);
  rw_opp_defense    := COALESCE((proposed_weights->>'w_opp_defense')::NUMERIC, current_row.w_opp_defense);
  rw_prop_type      := COALESCE((proposed_weights->>'w_prop_type')::NUMERIC, current_row.w_prop_type);
  rw_z_score        := COALESCE((proposed_weights->>'w_z_score')::NUMERIC, current_row.w_z_score);
  rw_role_change    := COALESCE((proposed_weights->>'w_role_change')::NUMERIC, current_row.w_role_change);
  rw_vig_filter     := COALESCE((proposed_weights->>'w_vig_filter')::NUMERIC, current_row.w_vig_filter);
  rw_usg_rate       := COALESCE((proposed_weights->>'w_usg_rate')::NUMERIC, current_row.w_usg_rate);
  rw_regression     := COALESCE((proposed_weights->>'w_regression')::NUMERIC, current_row.w_regression);
  rw_market_conf    := COALESCE((proposed_weights->>'w_market_conf')::NUMERIC, current_row.w_market_conf);
  rw_ha_split       := COALESCE((proposed_weights->>'w_ha_split')::NUMERIC, current_row.w_ha_split);
  rw_minutes_floor  := COALESCE((proposed_weights->>'w_minutes_floor')::NUMERIC, current_row.w_minutes_floor);
  rw_consistency    := COALESCE((proposed_weights->>'w_consistency')::NUMERIC, current_row.w_consistency);
  rw_stale_data     := COALESCE((proposed_weights->>'w_stale_data')::NUMERIC, current_row.w_stale_data);
  rw_player_injury  := COALESCE((proposed_weights->>'w_player_injury')::NUMERIC, current_row.w_player_injury);

  SELECT win_pct, picks INTO baseline_wr, baseline_picks
  FROM backtest_weights_v3_synthetic(
    current_row.w_l5, current_row.w_l10, current_row.w_season, current_row.w_floor_ceiling,
    current_row.w_recent_form, current_row.w_home_away, current_row.w_rest, current_row.w_b2b,
    current_row.w_minutes_trend, current_row.w_pace, current_row.w_opp_defense,
    current_row.w_prop_type, current_row.w_z_score, current_row.w_role_change,
    current_row.w_vig_filter, current_row.w_usg_rate, current_row.w_regression,
    current_row.w_market_conf, current_row.w_ha_split, current_row.w_minutes_floor,
    current_row.w_consistency, current_row.w_stale_data, current_row.w_player_injury
  ) WHERE threshold = confidence_threshold LIMIT 1;

  SELECT win_pct, picks INTO proposed_wr, proposed_picks
  FROM backtest_weights_v3_synthetic(
    rw_l5, rw_l10, rw_season, rw_floor_ceiling, rw_recent_form, rw_home_away,
    rw_rest, rw_b2b, rw_minutes_trend, rw_pace, rw_opp_defense, rw_prop_type,
    rw_z_score, rw_role_change, rw_vig_filter, rw_usg_rate, rw_regression,
    rw_market_conf, rw_ha_split, rw_minutes_floor, rw_consistency,
    rw_stale_data, rw_player_injury
  ) WHERE threshold = confidence_threshold LIMIT 1;

  delta_pp := COALESCE(proposed_wr, 0) - COALESCE(baseline_wr, 0);

  IF baseline_wr IS NULL OR proposed_wr IS NULL THEN
    status_val := 'rejected';
    reason_val := 'insufficient synthetic data at threshold ' || confidence_threshold;
  ELSIF delta_pp < -rejection_threshold_pp THEN
    status_val := 'rejected';
    reason_val := 'proposed weights would degrade synthetic WR by ' || ROUND(ABS(delta_pp), 2)
      || 'pp at threshold ' || confidence_threshold
      || ' (baseline=' || baseline_wr || '%, proposed=' || proposed_wr || '%)';
  ELSE
    status_val := 'applied';
    reason_val := 'proposed weights pass synthetic safety gate (delta=' || ROUND(delta_pp, 2)
      || 'pp at threshold ' || confidence_threshold || ')';
    UPDATE algorithm_weights
    SET w_l5 = rw_l5, w_l10 = rw_l10, w_season = rw_season,
        w_floor_ceiling = rw_floor_ceiling, w_recent_form = rw_recent_form,
        w_home_away = rw_home_away, w_rest = rw_rest, w_b2b = rw_b2b,
        w_minutes_trend = rw_minutes_trend, w_pace = rw_pace,
        w_opp_defense = rw_opp_defense, w_prop_type = rw_prop_type,
        w_z_score = rw_z_score, w_role_change = rw_role_change,
        w_vig_filter = rw_vig_filter, w_usg_rate = rw_usg_rate,
        w_regression = rw_regression, w_market_conf = rw_market_conf,
        w_ha_split = rw_ha_split, w_minutes_floor = rw_minutes_floor,
        w_consistency = rw_consistency, w_stale_data = rw_stale_data,
        w_player_injury = rw_player_injury,
        updated_at = NOW()
    WHERE id = 1;
  END IF;

  INSERT INTO public.safety_gate_log (
    status, confidence_threshold, baseline_wr, proposed_wr,
    baseline_pick_count, proposed_pick_count, delta_pp,
    proposed_weights, baseline_weights, reason, invoked_by
  ) VALUES (
    status_val, confidence_threshold, baseline_wr, proposed_wr,
    baseline_picks, proposed_picks, delta_pp,
    proposed_weights, baseline_weights_jsonb, reason_val, invoked_by
  ) RETURNING id INTO audit_id;

  RETURN jsonb_build_object(
    'status', status_val, 'baseline_wr', baseline_wr, 'proposed_wr', proposed_wr,
    'delta_pp', delta_pp, 'baseline_picks', baseline_picks,
    'proposed_picks', proposed_picks, 'reason', reason_val, 'audit_id', audit_id
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function 3: optimize_weights_synthetic_run
-- Coordinate-descent driver. Reads current weights, perturbs each ±0.25,
-- runs v3_synthetic for each candidate, picks best by win_pct at threshold
-- 70, routes through gate_synthetic. Single transaction.
-- ============================================================================
CREATE OR REPLACE FUNCTION optimize_weights_synthetic_run(
  perturb NUMERIC DEFAULT 0.25,
  confidence_threshold NUMERIC DEFAULT 70,
  min_improvement_pp NUMERIC DEFAULT 0.5
)
RETURNS JSONB AS $$
DECLARE
  cur RECORD;
  current_weights JSONB;
  baseline_wr NUMERIC;
  baseline_picks BIGINT;
  best_proposal JSONB := NULL;
  best_wr NUMERIC := -1000;
  best_perturb_key TEXT := NULL;
  best_perturb_dir INTEGER := 0;
  weight_keys TEXT[] := ARRAY[
    'w_l5','w_l10','w_season','w_floor_ceiling','w_recent_form',
    'w_home_away','w_rest','w_b2b','w_minutes_trend','w_pace',
    'w_opp_defense','w_prop_type','w_z_score','w_role_change',
    'w_vig_filter','w_usg_rate','w_regression','w_market_conf',
    'w_ha_split','w_minutes_floor','w_consistency','w_stale_data',
    'w_player_injury'
  ];
  k TEXT;
  direction INTEGER;
  cur_val NUMERIC;
  test_proposal JSONB;
  test_wr NUMERIC;
  iterations INTEGER := 0;
  gate_result JSONB;
BEGIN
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

  -- Baseline: current weights against synthetic data at threshold.
  SELECT win_pct, picks INTO baseline_wr, baseline_picks
  FROM backtest_weights_v3_synthetic(
    cur.w_l5, cur.w_l10, cur.w_season, cur.w_floor_ceiling, cur.w_recent_form,
    cur.w_home_away, cur.w_rest, cur.w_b2b, cur.w_minutes_trend, cur.w_pace,
    cur.w_opp_defense, cur.w_prop_type, cur.w_z_score, cur.w_role_change,
    cur.w_vig_filter, cur.w_usg_rate, cur.w_regression, cur.w_market_conf,
    cur.w_ha_split, cur.w_minutes_floor, cur.w_consistency, cur.w_stale_data,
    cur.w_player_injury
  ) WHERE threshold = confidence_threshold LIMIT 1;

  IF baseline_wr IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'no synthetic picks at threshold ' || confidence_threshold,
      'baseline_picks', COALESCE(baseline_picks, 0)
    );
  END IF;

  best_wr := baseline_wr;

  -- Coordinate descent: perturb each weight ±perturb, find best.
  FOREACH k IN ARRAY weight_keys LOOP
    FOR direction IN SELECT unnest(ARRAY[1, -1]) LOOP
      cur_val := (current_weights->>k)::NUMERIC;
      test_proposal := jsonb_set(
        current_weights, ARRAY[k],
        to_jsonb(GREATEST(0, cur_val + direction * perturb))
      );
      iterations := iterations + 1;
      SELECT win_pct INTO test_wr
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
      ) WHERE threshold = confidence_threshold LIMIT 1;

      IF test_wr IS NOT NULL AND test_wr > best_wr THEN
        best_wr := test_wr;
        best_proposal := test_proposal;
        best_perturb_key := k;
        best_perturb_dir := direction;
      END IF;
    END LOOP;
  END LOOP;

  -- If no improvement >= min_improvement_pp, don't even call the gate —
  -- just return informational result.
  IF best_proposal IS NULL OR (best_wr - baseline_wr) < min_improvement_pp THEN
    RETURN jsonb_build_object(
      'status', 'no_improvement',
      'baseline_wr', baseline_wr,
      'best_wr', best_wr,
      'delta_pp', best_wr - baseline_wr,
      'min_improvement_pp', min_improvement_pp,
      'baseline_picks', baseline_picks,
      'iterations', iterations,
      'best_perturb_key', best_perturb_key,
      'best_perturb_dir', best_perturb_dir,
      'reason', 'no perturbation improved win_pct by >= ' || min_improvement_pp
        || 'pp at threshold ' || confidence_threshold
    );
  END IF;

  -- Improvement found — route through synthetic-aware gate.
  gate_result := apply_optimized_weights_with_gate_synthetic(
    best_proposal, confidence_threshold, 'optimize_weights_synthetic_run'
  );

  RETURN gate_result || jsonb_build_object(
    'iterations', iterations,
    'best_perturb_key', best_perturb_key,
    'best_perturb_dir', best_perturb_dir,
    'best_perturb_amount', perturb,
    'optimizer_baseline_wr', baseline_wr,
    'optimizer_best_wr', best_wr
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION optimize_weights_synthetic_run IS
  'Coordinate-descent optimizer against the synthetic-pick corpus. 23 weights '
  '× 2 directions = 46 candidate backtests per call. Filters all backtests '
  'to is_synthetic=true. Returns gate result on improvement, or no_improvement '
  'status if best perturbation does not exceed min_improvement_pp threshold. '
  'Single manual invocation per CEO directive — pg_cron untouched.';
