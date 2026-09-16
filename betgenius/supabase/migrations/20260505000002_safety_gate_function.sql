-- ============================================================================
-- Migration : 20260505000002_safety_gate_function.sql
-- Date      : 2026-05-05
-- Purpose   : Two artifacts shipped together:
--               1. safety_gate_log audit table — records every invocation
--                  of apply_optimized_weights_with_gate with full context.
--               2. apply_optimized_weights_with_gate(proposed JSONB,
--                  confidence_threshold NUMERIC) function — wraps the
--                  optimizer's UPDATE step with a backtest gate. Rejects
--                  any proposed weights that backtest below current
--                  production WR by >1pp. On accept, applies the weights
--                  to algorithm_weights and logs to audit table.
--
-- Behavior   : Pure synchronous SQL. Does NOT call cron. Does NOT call
--              itself. No mutation unless gate passes.
--
-- Inputs    :
--              proposed_weights JSONB — must contain keys w_l5, w_l10,
--                w_season, w_floor_ceiling, w_recent_form, w_home_away,
--                w_rest, w_b2b, w_minutes_trend, w_pace, w_opp_defense,
--                w_prop_type, w_z_score, w_role_change, w_vig_filter,
--                w_usg_rate, w_regression, w_market_conf, w_ha_split,
--                w_minutes_floor, w_consistency, w_stale_data,
--                w_player_injury. Missing keys default to current
--                production weights (defensive — partial proposals
--                won't accidentally zero out weights).
--              confidence_threshold NUMERIC DEFAULT 70 — which tier
--                from backtest_weights_v3 result to compare on.
--
-- Returns   : JSONB with shape:
--               { status: 'applied' | 'rejected',
--                 baseline_wr: NUMERIC,
--                 proposed_wr: NUMERIC,
--                 delta_pp: NUMERIC,        -- proposed_wr - baseline_wr
--                 reason: TEXT,             -- human-readable
--                 audit_id: UUID }          -- foreign key to safety_gate_log
--
-- Rollback  :
--     DROP FUNCTION IF EXISTS apply_optimized_weights_with_gate(JSONB, NUMERIC);
--     DROP TABLE IF EXISTS public.safety_gate_log;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.safety_gate_log (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status                   TEXT         NOT NULL,  -- 'applied' | 'rejected'
  confidence_threshold     NUMERIC      NOT NULL,
  baseline_wr              NUMERIC,                -- baseline win pct at threshold
  proposed_wr              NUMERIC,                -- proposed win pct at threshold
  baseline_pick_count      BIGINT,                 -- sample size at threshold
  proposed_pick_count      BIGINT,
  delta_pp                 NUMERIC,                -- proposed - baseline (pp)
  proposed_weights         JSONB        NOT NULL,
  baseline_weights         JSONB        NOT NULL,
  reason                   TEXT,
  invoked_by               TEXT                    -- e.g. 'auto_optimize_weights' or 'manual'
);

CREATE INDEX IF NOT EXISTS idx_sgl_created   ON public.safety_gate_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sgl_status    ON public.safety_gate_log (status);

COMMENT ON TABLE public.safety_gate_log IS
  'Audit trail for apply_optimized_weights_with_gate invocations. Each row '
  'records baseline + proposed backtest WRs, the JSONB weight payloads, and '
  'the accept/reject outcome. Indefinite retention.';

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_optimized_weights_with_gate(
  proposed_weights JSONB,
  confidence_threshold NUMERIC DEFAULT 70,
  invoked_by TEXT DEFAULT 'manual'
)
RETURNS JSONB AS $$
DECLARE
  current_row              RECORD;
  baseline_result          RECORD;
  proposed_result          RECORD;
  baseline_wr              NUMERIC;
  proposed_wr              NUMERIC;
  baseline_picks           BIGINT;
  proposed_picks           BIGINT;
  delta_pp                 NUMERIC;
  status_val               TEXT;
  reason_val               TEXT;
  audit_id                 UUID;
  rejection_threshold_pp   CONSTANT NUMERIC := 1.0;  -- reject if proposed < baseline - 1.0pp
  baseline_weights_jsonb   JSONB;
  -- Resolved weight values (proposed → fallback to current row)
  rw_l5 NUMERIC; rw_l10 NUMERIC; rw_season NUMERIC; rw_floor_ceiling NUMERIC;
  rw_recent_form NUMERIC; rw_home_away NUMERIC; rw_rest NUMERIC; rw_b2b NUMERIC;
  rw_minutes_trend NUMERIC; rw_pace NUMERIC; rw_opp_defense NUMERIC;
  rw_prop_type NUMERIC; rw_z_score NUMERIC; rw_role_change NUMERIC;
  rw_vig_filter NUMERIC; rw_usg_rate NUMERIC; rw_regression NUMERIC;
  rw_market_conf NUMERIC; rw_ha_split NUMERIC; rw_minutes_floor NUMERIC;
  rw_consistency NUMERIC; rw_stale_data NUMERIC; rw_player_injury NUMERIC;
BEGIN
  -- Step 1: Read current production weights from algorithm_weights id=1.
  SELECT * INTO current_row FROM algorithm_weights WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'algorithm_weights id=1 not found — cannot establish baseline';
  END IF;

  -- Snapshot baseline weights as JSONB for the audit log.
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

  -- Step 2: Resolve proposed weights with fallback to current values for
  -- any missing keys. Defensive — partial proposals can't accidentally zero out.
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

  -- Step 3: Run baseline backtest (current weights).
  SELECT win_pct, picks INTO baseline_wr, baseline_picks
  FROM backtest_weights_v3(
    current_row.w_l5, current_row.w_l10, current_row.w_season, current_row.w_floor_ceiling,
    current_row.w_recent_form, current_row.w_home_away, current_row.w_rest, current_row.w_b2b,
    current_row.w_minutes_trend, current_row.w_pace, current_row.w_opp_defense,
    current_row.w_prop_type, current_row.w_z_score, current_row.w_role_change,
    current_row.w_vig_filter, current_row.w_usg_rate, current_row.w_regression,
    current_row.w_market_conf, current_row.w_ha_split, current_row.w_minutes_floor,
    current_row.w_consistency, current_row.w_stale_data, current_row.w_player_injury
  )
  WHERE threshold = confidence_threshold
  LIMIT 1;

  -- Step 4: Run proposed backtest.
  SELECT win_pct, picks INTO proposed_wr, proposed_picks
  FROM backtest_weights_v3(
    rw_l5, rw_l10, rw_season, rw_floor_ceiling, rw_recent_form, rw_home_away,
    rw_rest, rw_b2b, rw_minutes_trend, rw_pace, rw_opp_defense, rw_prop_type,
    rw_z_score, rw_role_change, rw_vig_filter, rw_usg_rate, rw_regression,
    rw_market_conf, rw_ha_split, rw_minutes_floor, rw_consistency,
    rw_stale_data, rw_player_injury
  )
  WHERE threshold = confidence_threshold
  LIMIT 1;

  -- Step 5: Compute delta + decide.
  delta_pp := COALESCE(proposed_wr, 0) - COALESCE(baseline_wr, 0);

  IF baseline_wr IS NULL OR proposed_wr IS NULL THEN
    status_val := 'rejected';
    reason_val := 'insufficient post-megadeploy data at threshold ' || confidence_threshold
      || ' for backtest comparison (baseline_wr=' || COALESCE(baseline_wr::TEXT, 'NULL')
      || ', proposed_wr=' || COALESCE(proposed_wr::TEXT, 'NULL') || ')';
  ELSIF delta_pp < -rejection_threshold_pp THEN
    status_val := 'rejected';
    reason_val := 'proposed weights would degrade WR by ' || ROUND(ABS(delta_pp), 2)
      || 'pp at threshold ' || confidence_threshold
      || ' (baseline=' || baseline_wr || '%, proposed=' || proposed_wr || '%)';
  ELSE
    status_val := 'applied';
    reason_val := 'proposed weights pass safety gate (delta=' || ROUND(delta_pp, 2)
      || 'pp at threshold ' || confidence_threshold || ')';
    -- Apply.
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

  -- Step 6: Audit log row (for both accept and reject paths).
  INSERT INTO public.safety_gate_log (
    status, confidence_threshold, baseline_wr, proposed_wr,
    baseline_pick_count, proposed_pick_count, delta_pp,
    proposed_weights, baseline_weights, reason, invoked_by
  )
  VALUES (
    status_val, confidence_threshold, baseline_wr, proposed_wr,
    baseline_picks, proposed_picks, delta_pp,
    proposed_weights, baseline_weights_jsonb, reason_val, invoked_by
  )
  RETURNING id INTO audit_id;

  -- Step 7: Return structured result.
  RETURN jsonb_build_object(
    'status', status_val,
    'baseline_wr', baseline_wr,
    'proposed_wr', proposed_wr,
    'delta_pp', delta_pp,
    'baseline_picks', baseline_picks,
    'proposed_picks', proposed_picks,
    'reason', reason_val,
    'audit_id', audit_id
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apply_optimized_weights_with_gate IS
  'Wraps any optimizer UPDATE on algorithm_weights with a safety gate. '
  'Runs backtest_weights_v3 with current vs proposed weights at the target '
  'confidence threshold; rejects any proposal that backtests >1pp below '
  'current production WR. Applies + audits on accept; logs + returns the '
  'rejection reason on reject. Pure synchronous SQL. Does not invoke any '
  'cron. Auto-optimize cron remains UNSCHEDULED until manually scheduled '
  'after C16 closure validation.';
