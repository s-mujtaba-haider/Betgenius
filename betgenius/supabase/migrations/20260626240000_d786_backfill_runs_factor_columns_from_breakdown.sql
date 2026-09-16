-- D-786 — One-time backfill: populate the 10 D-785 top-level factor columns
-- on pre-D-785 batter_runs_scored picks from their existing `breakdown` JSONB.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────
-- D-785 added 10 batter factor columns to the schema + RPC + payload
-- pipeline. Going-forward (post-D-785-deploy at ~23:00 UTC 2026-06-26) every
-- fresh batter_runs_scored pick populates these columns. But the existing
-- 4,247 picks scored BEFORE the deploy have NULL on the new top-level
-- columns — the optimizer reading dedicated columns can't see them.
--
-- The factor VALUES already exist in those picks' `breakdown` JSONB
-- (verified D-786 STEP 0: 4/10 keys 100% present, 6/10 keys 62-67% present).
-- This migration extracts the values from breakdown and writes them to the
-- new top-level columns — a one-time DB-side transform with NO API spend.
--
-- WHEN
-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-26 (D-786). Pre-D-785-deploy picks span 2026-06-13 → 2026-06-26
-- (the post-D-785 picks from 23:11 UTC onward already have populated columns
-- and are guarded by the `IS NULL` clause below — they won't be touched).
--
-- SCOPE
-- ─────────────────────────────────────────────────────────────────────
-- mlb_market_type = 'batter_runs_scored'                 (single market)
-- AND breakdown IS NOT NULL                              (only picks with source data)
-- AND each column UPDATE gated by `IS NULL` on that      (skip already-populated post-D-785 rows)
--     specific column individually
--
-- ONLY THE 10 D-785 COLUMNS are modified. Every other column is preserved.
-- No DELETE, no row-level changes, no FK touches.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────
-- This UPDATE writes values from existing breakdown JSONB into new columns.
-- It does NOT modify breakdown. Rollback options:
--   1. Re-NULL the 10 columns via: UPDATE public.pick_history SET <col>=NULL
--      WHERE mlb_market_type='batter_runs_scored' (loses post-D-785 values too)
--   2. Just leave it — the values are CORRECT (they match breakdown), so the
--      "rollback" is moot. The backfill aligns the pre-D-785 rows with the
--      post-D-785 emission pattern.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────────────
-- The `WHERE X IS NULL` gate makes this idempotent. Re-running the migration
-- does nothing (all rows already have non-NULL values where breakdown had a key).
-- Where breakdown lacks a key (the 6 sample-size-guarded factors with 62-67%
-- coverage), the column stays NULL — we CAN'T fabricate a value that wasn't
-- in the source data (per D-786 escalation #1: "those stay NULL — can't
-- fabricate").

BEGIN;

-- The 10 columns, one UPDATE each. PostgreSQL `breakdown->>'key'` extracts
-- the JSONB key as text; `::NUMERIC` casts to numeric. NULL from JSONB lookup
-- (key absent) → NULL via the cast — safe.
--
-- Per-column UPDATEs (not a single multi-column SET) keep the per-column
-- IS NULL gate honest: a column gets backfilled only if THAT specific column
-- is NULL on the row, and the breakdown HAS that key.

UPDATE public.pick_history
SET score_batter_obp = (breakdown->>'score_batter_obp')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_obp'
  AND score_batter_obp IS NULL;

UPDATE public.pick_history
SET score_recent_run_form = (breakdown->>'score_recent_run_form')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_recent_run_form'
  AND score_recent_run_form IS NULL;

UPDATE public.pick_history
SET score_lineup_spot = (breakdown->>'score_lineup_spot')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_lineup_spot'
  AND score_lineup_spot IS NULL;

UPDATE public.pick_history
SET score_bullpen_quality = (breakdown->>'score_bullpen_quality')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_bullpen_quality'
  AND score_bullpen_quality IS NULL;

UPDATE public.pick_history
SET score_opp_pitcher_pitchtype_quality = (breakdown->>'score_opp_pitcher_pitchtype_quality')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_opp_pitcher_pitchtype_quality'
  AND score_opp_pitcher_pitchtype_quality IS NULL;

UPDATE public.pick_history
SET score_batter_xba = (breakdown->>'score_batter_xba')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_xba'
  AND score_batter_xba IS NULL;

UPDATE public.pick_history
SET score_batter_exit_velo_trend = (breakdown->>'score_batter_exit_velo_trend')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_exit_velo_trend'
  AND score_batter_exit_velo_trend IS NULL;

UPDATE public.pick_history
SET score_batter_barrel_rate = (breakdown->>'score_batter_barrel_rate')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_barrel_rate'
  AND score_batter_barrel_rate IS NULL;

UPDATE public.pick_history
SET score_batter_xslg_regression = (breakdown->>'score_batter_xslg_regression')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_xslg_regression'
  AND score_batter_xslg_regression IS NULL;

UPDATE public.pick_history
SET score_batter_vs_pitcher_hand_split = (breakdown->>'score_batter_vs_pitcher_hand_split')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_vs_pitcher_hand_split'
  AND score_batter_vs_pitcher_hand_split IS NULL;

COMMIT;
