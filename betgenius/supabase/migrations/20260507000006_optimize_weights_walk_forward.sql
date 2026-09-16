-- ML Optimizer Upgrade Phase 4 — walk-forward validation wrapper (May 7).
--
-- The signal-vs-overfit guard. Wraps optimize_weights_multi_weight to:
--   1. Train: run multi-weight search on Feb 1 - Mar 31 synthetic data
--   2. Capture: best proposal and its train-window improvement (delta_train)
--   3. Validate: re-run backtest with proposed weights on held-out
--      Apr 1 - May 3 synthetic data. Compute validate-window improvement
--      (delta_validate = validate_proposed_wr - validate_baseline_wr).
--   4. Decide based on delta_validate (NOT absolute WR — train and validate
--      windows have different baselines because synthetic scoring sources
--      use current state-of-data which favors more-recent picks):
--        APPROVE       if delta_validate >  0.5   (real signal — held out)
--        NO_SIGNAL     if -0.5 ≤ delta_validate ≤ 0.5 (within noise)
--        REJECT_OVERFIT if delta_validate < -0.5  (training overfit)
--
-- This function does NOT apply weights. It returns the proposal + decision
-- audit. Phase 5 (CEO-online tomorrow) wires this into a new edge function
-- run-optimizer-v2 that conditionally applies via apply_optimized_weights_with_gate_synthetic.
--
-- Default windows:
--   TRAIN_START = '2026-02-01'  TRAIN_END = '2026-03-31'  (~6,461 picks)
--   VALID_START = '2026-04-01'  VALID_END = '2026-05-03'  (~5,042 picks)
--
-- Per session constraints:
--   - ADDITIVE only — old optimize_weights_synthetic_run still LIVE
--   - Does NOT modify auto_optimize_weights / backtest_weights_v3 /
--     apply_optimized_weights_with_gate
--   - Does NOT mutate algorithm_weights — pure read-only against pick_history
--   - Does NOT route through any apply_*_with_gate function — Phase 5 work

CREATE OR REPLACE FUNCTION optimize_weights_walk_forward(
  threshold INTEGER DEFAULT 70,
  train_start DATE DEFAULT '2026-02-01',
  train_end DATE DEFAULT '2026-03-31',
  validate_start DATE DEFAULT '2026-04-01',
  validate_end DATE DEFAULT '2026-05-03',
  approve_threshold_pp NUMERIC DEFAULT 0.5,
  reject_threshold_pp NUMERIC DEFAULT 0.5
)
RETURNS JSONB AS $$
DECLARE
  cur RECORD;
  train_result JSONB;
  proposal JSONB;
  proposal_status TEXT;
  -- Train-window stats (from multi-weight search itself)
  train_baseline_wr NUMERIC;
  train_proposed_wr NUMERIC;
  train_baseline_picks BIGINT;
  train_delta NUMERIC;
  -- Validate-window stats (rerun with current vs proposed weights)
  validate_baseline_wr NUMERIC;
  validate_proposed_wr NUMERIC;
  validate_baseline_picks BIGINT;
  validate_proposed_picks BIGINT;
  validate_delta NUMERIC;
  -- Decision
  decision TEXT;
  decision_reason TEXT;
BEGIN
  -- Step 1: Read current weights for validate-window baseline
  SELECT * INTO cur FROM algorithm_weights WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'algorithm_weights id=1 not found');
  END IF;

  -- Step 2: Run multi-weight search on TRAIN window
  train_result := optimize_weights_multi_weight(
    threshold,
    use_windowed := true,
    train_start := train_start,
    train_end := train_end
  );

  proposal_status := train_result->>'status';
  train_baseline_wr := (train_result->>'baseline_wr')::NUMERIC;
  train_proposed_wr := (train_result->>'best_wr')::NUMERIC;
  train_baseline_picks := (train_result->>'baseline_picks')::BIGINT;
  train_delta := (train_result->>'delta_pp')::NUMERIC;
  proposal := train_result->'best_proposal';

  -- Early exit if multi-weight search itself reported error or no improvement
  IF proposal_status = 'error' THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'training phase failed: ' || COALESCE(train_result->>'reason', '(no reason)'),
      'train_result', train_result
    );
  END IF;

  IF proposal IS NULL OR proposal_status = 'no_improvement' THEN
    -- No proposal to validate. Still report train-window stats for visibility.
    RETURN jsonb_build_object(
      'status', 'no_proposal',
      'decision', 'NO_PROPOSAL',
      'reason', 'multi-weight search found no improvement on training window',
      'train_baseline_wr', train_baseline_wr,
      'train_proposed_wr', train_proposed_wr,
      'train_delta_pp', train_delta,
      'train_baseline_picks', train_baseline_picks,
      'train_window', jsonb_build_object('start', train_start, 'end', train_end),
      'threshold', threshold,
      'train_result', train_result
    );
  END IF;

  -- Step 3: Run validate-window baseline with CURRENT weights
  SELECT win_pct, picks INTO validate_baseline_wr, validate_baseline_picks
  FROM backtest_weights_v3_synthetic_windowed(
    validate_start, validate_end,
    cur.w_l5, cur.w_l10, cur.w_season, cur.w_floor_ceiling, cur.w_recent_form,
    cur.w_home_away, cur.w_rest, cur.w_b2b, cur.w_minutes_trend, cur.w_pace,
    cur.w_opp_defense, cur.w_prop_type, cur.w_z_score, cur.w_role_change,
    cur.w_vig_filter, cur.w_usg_rate, cur.w_regression, cur.w_market_conf,
    cur.w_ha_split, cur.w_minutes_floor, cur.w_consistency, cur.w_stale_data,
    cur.w_player_injury, true
  )
  WHERE backtest_weights_v3_synthetic_windowed.threshold = optimize_weights_walk_forward.threshold
  LIMIT 1;

  -- Step 4: Run validate-window with PROPOSED weights
  SELECT win_pct, picks INTO validate_proposed_wr, validate_proposed_picks
  FROM backtest_weights_v3_synthetic_windowed(
    validate_start, validate_end,
    (proposal->>'w_l5')::NUMERIC, (proposal->>'w_l10')::NUMERIC,
    (proposal->>'w_season')::NUMERIC, (proposal->>'w_floor_ceiling')::NUMERIC,
    (proposal->>'w_recent_form')::NUMERIC, (proposal->>'w_home_away')::NUMERIC,
    (proposal->>'w_rest')::NUMERIC, (proposal->>'w_b2b')::NUMERIC,
    (proposal->>'w_minutes_trend')::NUMERIC, (proposal->>'w_pace')::NUMERIC,
    (proposal->>'w_opp_defense')::NUMERIC, (proposal->>'w_prop_type')::NUMERIC,
    (proposal->>'w_z_score')::NUMERIC, (proposal->>'w_role_change')::NUMERIC,
    (proposal->>'w_vig_filter')::NUMERIC, (proposal->>'w_usg_rate')::NUMERIC,
    (proposal->>'w_regression')::NUMERIC, (proposal->>'w_market_conf')::NUMERIC,
    (proposal->>'w_ha_split')::NUMERIC, (proposal->>'w_minutes_floor')::NUMERIC,
    (proposal->>'w_consistency')::NUMERIC, (proposal->>'w_stale_data')::NUMERIC,
    (proposal->>'w_player_injury')::NUMERIC, true
  )
  WHERE backtest_weights_v3_synthetic_windowed.threshold = optimize_weights_walk_forward.threshold
  LIMIT 1;

  validate_delta := COALESCE(validate_proposed_wr, 0) - COALESCE(validate_baseline_wr, 0);

  -- Step 5: Decision based on validate_delta (NOT absolute WR)
  IF validate_baseline_wr IS NULL OR validate_proposed_wr IS NULL THEN
    decision := 'INSUFFICIENT_VALIDATE_DATA';
    decision_reason := 'validate window has insufficient picks at threshold ' || threshold;
  ELSIF validate_delta < -reject_threshold_pp THEN
    decision := 'REJECT_OVERFIT';
    decision_reason := 'training improvement of ' || ROUND(train_delta, 2)
      || 'pp did not transfer — proposed weights perform '
      || ROUND(ABS(validate_delta), 2) || 'pp WORSE on held-out validation. Likely overfit.';
  ELSIF validate_delta > approve_threshold_pp THEN
    decision := 'APPROVE';
    decision_reason := 'proposed weights improve validate-window WR by '
      || ROUND(validate_delta, 2) || 'pp (train improvement: '
      || ROUND(train_delta, 2) || 'pp). Held-out signal confirmed.';
  ELSE
    decision := 'NO_SIGNAL';
    decision_reason := 'validate-window delta '
      || ROUND(validate_delta, 2) || 'pp within noise band ['
      || -reject_threshold_pp || ', ' || approve_threshold_pp
      || ']. Train improvement of ' || ROUND(train_delta, 2) || 'pp not reproducible.';
  END IF;

  RETURN jsonb_build_object(
    'status', 'completed',
    'decision', decision,
    'decision_reason', decision_reason,
    'threshold', threshold,
    'train_window', jsonb_build_object('start', train_start, 'end', train_end),
    'validate_window', jsonb_build_object('start', validate_start, 'end', validate_end),
    'train_baseline_wr', train_baseline_wr,
    'train_proposed_wr', train_proposed_wr,
    'train_baseline_picks', train_baseline_picks,
    'train_delta_pp', train_delta,
    'validate_baseline_wr', validate_baseline_wr,
    'validate_proposed_wr', validate_proposed_wr,
    'validate_baseline_picks', validate_baseline_picks,
    'validate_proposed_picks', validate_proposed_picks,
    'validate_delta_pp', validate_delta,
    'best_descriptor', train_result->>'best_descriptor',
    'best_pass', train_result->>'best_pass',
    'iterations', train_result->>'iterations',
    'proposal', proposal,
    'pass1_top5', train_result->'pass1_top5'
  );
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION optimize_weights_walk_forward(INTEGER, DATE, DATE, DATE, DATE, NUMERIC, NUMERIC)
  SET statement_timeout = '300s';

COMMENT ON FUNCTION optimize_weights_walk_forward IS
  'ML Optimizer Phase 4 (May 7). Wraps optimize_weights_multi_weight with '
  'walk-forward validation: trains on synthetic Feb-Mar, validates on '
  'synthetic Apr-May, returns proposal + decision (APPROVE / NO_SIGNAL / '
  'REJECT_OVERFIT / NO_PROPOSAL / INSUFFICIENT_VALIDATE_DATA / error). Does '
  'NOT apply weights — Phase 5 edge function wraps and conditionally applies '
  'via apply_optimized_weights_with_gate_synthetic.';
