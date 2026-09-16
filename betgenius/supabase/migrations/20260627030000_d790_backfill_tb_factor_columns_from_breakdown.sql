-- D-790 — One-time backfill: populate the 10 D-785 top-level factor columns
-- on pre-D-785/D-789 batter_total_bases picks from their existing `breakdown` JSONB.
--
-- Mirrors D-786 (which did the same for batter_runs_scored). This migration
-- closes the same gap on the larger TB cohort so the D-791 OOS factor tune
-- has dedicated-column access to the 8 backfillable factors.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────
-- D-785 added 10 batter factor columns to the schema + RPC + payload
-- pipeline. Going-forward (post-D-789-deploy at ~02:25 UTC 2026-06-27)
-- every fresh batter_total_bases pick populates these columns at top-level.
-- But the existing ~6,541 batter_total_bases picks scored BEFORE the D-785
-- payload extension have NULL on the new top-level columns — the optimizer
-- reading dedicated columns can't see them.
--
-- The factor VALUES already exist in those picks' `breakdown` JSONB for 8
-- of the 10 keys (per pre-flight check on a 1000-row sample of the
-- score_lineup_spot IS NULL set):
--   score_lineup_spot:                    100.0% present (1000/1000)
--   score_bullpen_quality:                100.0% present
--   score_opp_pitcher_pitchtype_quality:   56.3% present (D-598 sample-size gated)
--   score_batter_xba:                     100.0% present
--   score_batter_exit_velo_trend:         100.0% present
--   score_batter_barrel_rate:             100.0% present
--   score_batter_xslg_regression:         100.0% present
--   score_batter_vs_pitcher_hand_split:   100.0% present
--   score_batter_obp:                       0.0% present (runs-only baseline)
--   score_recent_run_form:                  0.0% present (runs-only baseline)
--
-- The two 0%-coverage columns (obp + recent_run_form) are by-design absent
-- from breakdown on TB picks — scoreBatterMarket emits them as runs-only
-- baselines and does not log them in breakdown for non-runs markets. They
-- stay NULL post-backfill per the D-790 escalation #1 ("don't fabricate").
--
-- WHEN
-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-27 (D-790). Pre-D-789-deploy picks span 2026-04-29 → 2026-06-27.
-- The post-D-789 picks (from 02:25 UTC 2026-06-27 onward) already have
-- populated columns and are guarded by the `IS NULL` clause below — they
-- won't be touched.
--
-- SCOPE
-- ─────────────────────────────────────────────────────────────────────
-- mlb_market_type = 'batter_total_bases'                 (single market — TB only)
-- AND breakdown IS NOT NULL                              (only picks with source data)
-- AND each column UPDATE gated by `IS NULL` on that      (skip already-populated post-D-789 rows)
--     specific column individually
-- AND breakdown ? '<key>'                                 (only when breakdown has the key — D-790 escalation #1)
--
-- ONLY THE 8 BACKFILLABLE D-785 COLUMNS are written. The 2 runs-only-baseline
-- columns (obp + recent_run_form) are NOT touched — they stay NULL because
-- the breakdown source data lacks them on TB picks (the scorer's design).
-- Every other column is preserved. No DELETE, no row-level changes, no FK touches.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────
-- This UPDATE writes values from existing breakdown JSONB into new columns.
-- It does NOT modify breakdown. Rollback options:
--   1. Re-NULL the 8 columns via: UPDATE public.pick_history SET <col>=NULL
--      WHERE mlb_market_type='batter_total_bases' (loses post-D-789 values too)
--   2. Just leave it — the values are CORRECT (they match breakdown), so the
--      "rollback" is moot. The backfill aligns the pre-D-789 rows with the
--      post-D-789 emission pattern.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────────────
-- The `WHERE X IS NULL` gate makes this idempotent. Re-running the migration
-- does nothing (all rows already have non-NULL values where breakdown had a key).
-- Where breakdown lacks a key (the D-598 opp_pitcher_pitchtype_quality with
-- ~56% coverage), the column stays NULL — we CAN'T fabricate a value that
-- wasn't in the source data (per D-790 escalation #1: "those stay NULL —
-- can't fabricate").

BEGIN;

-- The 8 backfillable columns, one UPDATE each. PostgreSQL `breakdown->>'key'`
-- extracts the JSONB key as text; `::NUMERIC` casts to numeric. NULL from
-- JSONB lookup (key absent) → NULL via the cast — safe.
--
-- Per-column UPDATEs (not a single multi-column SET) keep the per-column
-- IS NULL gate honest: a column gets backfilled only if THAT specific column
-- is NULL on the row, and the breakdown HAS that key.
--
-- NOTE: score_batter_obp + score_recent_run_form are NOT in this migration.
-- Breakdown on TB picks does not carry those keys (scoreBatterMarket design;
-- they are runs-only baselines emitted as 0 at top-level on fresh picks but
-- never logged to breakdown for non-runs markets). The D-790 escalation #1
-- explicitly forbids fabricating values, so they stay NULL.

UPDATE public.pick_history
SET score_lineup_spot = (breakdown->>'score_lineup_spot')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_lineup_spot'
  AND score_lineup_spot IS NULL;

UPDATE public.pick_history
SET score_bullpen_quality = (breakdown->>'score_bullpen_quality')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_bullpen_quality'
  AND score_bullpen_quality IS NULL;

UPDATE public.pick_history
SET score_opp_pitcher_pitchtype_quality = (breakdown->>'score_opp_pitcher_pitchtype_quality')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_opp_pitcher_pitchtype_quality'
  AND score_opp_pitcher_pitchtype_quality IS NULL;

UPDATE public.pick_history
SET score_batter_xba = (breakdown->>'score_batter_xba')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_xba'
  AND score_batter_xba IS NULL;

UPDATE public.pick_history
SET score_batter_exit_velo_trend = (breakdown->>'score_batter_exit_velo_trend')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_exit_velo_trend'
  AND score_batter_exit_velo_trend IS NULL;

UPDATE public.pick_history
SET score_batter_barrel_rate = (breakdown->>'score_batter_barrel_rate')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_barrel_rate'
  AND score_batter_barrel_rate IS NULL;

UPDATE public.pick_history
SET score_batter_xslg_regression = (breakdown->>'score_batter_xslg_regression')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_xslg_regression'
  AND score_batter_xslg_regression IS NULL;

UPDATE public.pick_history
SET score_batter_vs_pitcher_hand_split = (breakdown->>'score_batter_vs_pitcher_hand_split')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_vs_pitcher_hand_split'
  AND score_batter_vs_pitcher_hand_split IS NULL;

COMMIT;
