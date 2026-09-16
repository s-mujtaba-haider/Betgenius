-- ============================================================================
-- Migration : 20260505000004_auto_optimize_v3.sql
-- Date      : 2026-05-05
-- Purpose   : C16 Phase 2 — rewrite auto_optimize_weights() body to call
--             backtest_weights_v3 instead of v1 (broken) and route through
--             apply_optimized_weights_with_gate instead of direct UPDATE on
--             algorithm_weights. Closes the third DO-NOT item from the
--             original C16 plan now that v3 + safety gate have shipped
--             (commit 958dbd3, D-081).
--
-- Context   :
--   - The ORIGINAL auto_optimize_weights() body was created in v2.3 (Apr 8,
--     2026) and lives only in production — no committed migration in
--     supabase/migrations/ defines it. The body is presumed to call
--     backtest_weights() (v1, broken since C16 was opened Apr 22) and to
--     UPDATE algorithm_weights directly.
--   - This Claude Code session has no arbitrary-SQL surface against the
--     production DB and `supabase db dump` requires Docker (unavailable).
--     The existing body could not be read for line-by-line preservation.
--   - Per D-083, CEO chose Path C: manual weight tuning until ~3000
--     post-megadeploy picks accumulate (~end of May 2026). Cron remains
--     UNSCHEDULED. So this function isn't running on a schedule; this
--     migration only matters when CEO eventually re-enables the cron.
--
-- Approach :
--   - Replace the body with a SAFE PLACEHOLDER that satisfies the spec's
--     structural goals (calls v3, routes through safety gate) without
--     inventing optimizer logic that might shadow CEO's prior tuning.
--   - The placeholder builds a no-op proposal (current weights as the
--     "proposed weights") and calls apply_optimized_weights_with_gate.
--     The gate sees delta = 0pp, applies (touches updated_at), and writes
--     a safety_gate_log row. No actual weight values change.
--   - When cron unlocks at end-of-May 2026, replace the no-op proposal
--     with real coordinate-descent perturbation (TODO block at the bottom
--     of this function).
--
-- Cron schedule : remains UNSCHEDULED. This migration changes the function
--                 body only. pg_cron is untouched.
--
-- Rollback :
--     -- The pre-rewrite body lives only in production, not in this repo.
--     -- To roll back: CEO recovers the previous body from production
--     -- backup (Supabase point-in-time-recovery within 7 days), or
--     -- recreates it manually. The current body called v1 backtest +
--     -- direct UPDATE; if you need to roll back, you'd be restoring the
--     -- broken state per C16 anyway, so rollback is rarely the right move.
--     DROP FUNCTION IF EXISTS auto_optimize_weights();
-- ============================================================================

-- The existing function (created Apr 8, 2026 in v2.3, lives only in
-- production) has a non-JSONB return type per Postgres error 42P13
-- ("cannot change return type of existing function") observed on the
-- first migration apply attempt. CREATE OR REPLACE can't change return
-- type, so DROP first. Safe because:
--   - Cron is UNSCHEDULED per D-022 (Apr 22) and reaffirmed D-081 (May 5)
--     — no scheduled invocation depends on this function
--   - No other function or migration in this repo references
--     auto_optimize_weights — it's an isolated optimizer entry point
--   - IF EXISTS makes this idempotent if the function is somehow already
--     gone before this migration runs
-- If DROP fails with "depends on" errors, an external dependency exists
-- that needs investigation BEFORE this migration applies. Do NOT add
-- CASCADE without that investigation — would silently drop dependents.
DROP FUNCTION IF EXISTS auto_optimize_weights();

CREATE FUNCTION auto_optimize_weights()
RETURNS JSONB AS $$
DECLARE
  cur RECORD;
  current_weights JSONB;
  result JSONB;
BEGIN
  -- Step 1: Read current production weights from algorithm_weights id=1.
  SELECT * INTO cur FROM algorithm_weights WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'algorithm_weights id=1 not found — cannot establish baseline'
    );
  END IF;

  -- Step 2: Build the proposal JSONB. This placeholder version proposes
  -- the CURRENT weights (no-op). When cron unlocks at end-of-May 2026,
  -- replace this block with real coordinate-descent perturbation per the
  -- TODO at the bottom of this function.
  current_weights := jsonb_build_object(
    'w_l5',             cur.w_l5,
    'w_l10',            cur.w_l10,
    'w_season',         cur.w_season,
    'w_floor_ceiling',  cur.w_floor_ceiling,
    'w_recent_form',    cur.w_recent_form,
    'w_home_away',      cur.w_home_away,
    'w_rest',           cur.w_rest,
    'w_b2b',            cur.w_b2b,
    'w_minutes_trend',  cur.w_minutes_trend,
    'w_pace',           cur.w_pace,
    'w_opp_defense',    cur.w_opp_defense,
    'w_prop_type',      cur.w_prop_type,
    'w_z_score',        cur.w_z_score,
    'w_role_change',    cur.w_role_change,
    'w_vig_filter',     cur.w_vig_filter,
    'w_usg_rate',       cur.w_usg_rate,
    'w_regression',     cur.w_regression,
    'w_market_conf',    cur.w_market_conf,
    'w_ha_split',       cur.w_ha_split,
    'w_minutes_floor',  cur.w_minutes_floor,
    'w_consistency',    cur.w_consistency,
    'w_stale_data',     cur.w_stale_data,
    'w_player_injury',  cur.w_player_injury
  );

  -- Step 3: Route through safety gate at threshold 70. Since proposal ==
  -- current, delta_pp will be 0 → gate APPLIES (delta >= -1pp rejection
  -- threshold). algorithm_weights.updated_at gets a NOW() bump but no
  -- value changes. safety_gate_log records the invocation with full
  -- baseline + proposed snapshots and the 0pp delta.
  result := apply_optimized_weights_with_gate(
    current_weights,
    70,                          -- confidence_threshold
    'auto_optimize_weights'      -- invoked_by
  );

  -- Augment result with placeholder-mode marker so callers know this run
  -- did not exercise real optimizer logic.
  RETURN result || jsonb_build_object(
    'optimizer_mode', 'placeholder_no_op',
    'note', 'Path C manual control per D-083. Cron unscheduled. Real coordinate-descent activates at end of May 2026 — see TODO in function body.'
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_optimize_weights IS
  'C16 Phase 2 placeholder rewrite (May 5, 2026). Calls backtest_weights_v3 '
  '(via apply_optimized_weights_with_gate) instead of v1 (broken). Currently '
  'a no-op orchestrator: proposes current weights, gate auto-applies with '
  'delta=0, audit log row written to safety_gate_log on every invocation. '
  'pg_cron schedule remains UNSCHEDULED per D-083 Path C. Replace the '
  'no-op proposal block with real coordinate-descent perturbation when '
  'cron unlocks at end of May 2026.';

-- ============================================================================
-- TODO (when cron unlocks at end of May 2026 — see D-083 + framework §15.2)
-- ============================================================================
-- Replace Step 2 above with coordinate-descent perturbation:
--
--   DECLARE
--     baseline_wr NUMERIC;
--     best_proposal JSONB := NULL;
--     best_wr NUMERIC := 0;
--     perturb NUMERIC := 0.25;
--     weight_keys TEXT[] := ARRAY[
--       'w_l5','w_l10','w_season','w_floor_ceiling','w_recent_form',
--       'w_home_away','w_rest','w_b2b','w_minutes_trend','w_pace',
--       'w_opp_defense','w_prop_type','w_z_score','w_role_change',
--       'w_vig_filter','w_usg_rate','w_regression','w_market_conf',
--       'w_ha_split','w_minutes_floor','w_consistency','w_stale_data',
--       'w_player_injury'
--     ];
--     k TEXT; cur_val NUMERIC; test_proposal JSONB; test_wr NUMERIC;
--
-- Per-iteration logic (inside FOREACH k IN ARRAY weight_keys LOOP):
--   FOR direction IN ARRAY[1, -1] LOOP
--     cur_val := (current_weights->>k)::NUMERIC;
--     test_proposal := jsonb_set(current_weights, ARRAY[k], to_jsonb(GREATEST(0, cur_val + direction * perturb)));
--     SELECT win_pct INTO test_wr
--     FROM backtest_weights_v3(
--       (test_proposal->>'w_l5')::NUMERIC, (test_proposal->>'w_l10')::NUMERIC,
--       ...23 args extracted from test_proposal JSONB...
--     )
--     WHERE threshold = 70 LIMIT 1;
--     IF test_wr IS NOT NULL AND test_wr > best_wr THEN
--       best_wr := test_wr; best_proposal := test_proposal;
--     END IF;
--   END LOOP;
--
-- Decision logic AFTER the loop:
--   - If best_proposal IS NULL OR (best_wr - baseline_wr) < 0.5pp:
--       RETURN jsonb_build_object('status', 'no_improvement', 'baseline_wr', baseline_wr);
--   - Otherwise:
--       RETURN apply_optimized_weights_with_gate(best_proposal, 70, 'auto_optimize_weights');
--
-- The safety gate's >1pp degradation rejection threshold handles noise.
-- Combined with the 0.5pp improvement filter above, only well-supported
-- proposals make it through.
--
-- Notes for the future expansion:
--   - 23 weights × 2 directions = 46 v3 invocations per cron run. v3 is
--     LANGUAGE SQL STABLE so query planner can optimize, but each call
--     still scans pick_history. Consider materializing post-megadeploy
--     picks into a smaller view if cron runtime is a concern.
--   - perturb := 0.25 is a starting step size. Could be made adaptive
--     (smaller as we approach optimum) — defer until empirical data
--     shows the simple version is too slow to converge.
--   - Single-perturbation-per-run keeps each cron tick small and lets
--     CEO observe gradual changes vs all-at-once weight blast.
-- ============================================================================
