-- D-793 — Complete the D-786 backfill: populate D-758 top-level factor
-- columns on batter_runs_scored picks from existing `breakdown` JSONB.
--
-- D-786 backfilled the 10 D-785 columns on runs_scored picks but did NOT
-- touch the 13 D-758 columns. D-787 ran the OOS tune with those 7 D-758 cols
-- (now 100% NULL on the consistent-model cohort) DROPPED, using only linear
-- ridge. D-792 proved on TB that a per-bin model with complete factors can
-- find signal linear missed; D-793 repeats that test on runs_scored.
--
-- This migration backfills the 5 D-758 cols whose values exist in breakdown
-- JSONB on runs_scored picks. The other 2 (recent_at_bats, pitcher_hr_rate)
-- are NOT in breakdown for this market (scoreBatterRunsScored emits them
-- to top-level only when D-758 column write path is live) and stay NULL
-- per D-793 escalation #1 ("don't fabricate").
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────
-- Pre-flight check on 500 runs_scored picks with breakdown JSONB:
--   score_batter_hit_rate:              37.0% present  ← partial backfill
--   score_batter_form:                  37.0% present  ← partial backfill
--   score_opposing_pitcher_quality:    100.0% present  ← full backfill
--   score_recent_at_bats:                0.0% present  ← STAYS NULL (not in breakdown)
--   score_batter_power_rate:            37.0% present  ← partial backfill
--   score_batter_form_power:            37.0% present  ← partial backfill
--   score_pitcher_hr_rate:               0.0% present  ← STAYS NULL (not in breakdown)
--
-- 5 of the 7 can be backfilled (varying coverage 37-100%). 2 stay NULL —
-- those keys are absent from runs_scored breakdown (the scorer doesn't log
-- them for this market in the breakdown JSONB).
--
-- Why D-786 missed these: D-786 backfilled the 10 D-785 columns only (the
-- explicit D-785 schema additions). The D-758 columns were a separate batch
-- of column additions (13 columns added in D-758 migration 20260625210000),
-- which D-786 didn't address. D-793 closes that gap for runs_scored.
--
-- WHEN
-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-27 (D-793). Pre-D-758 picks (created_at < 2026-06-25) lacked these
-- columns at top-level. The `IS NULL` per-column gate makes this idempotent.
--
-- SCOPE
-- ─────────────────────────────────────────────────────────────────────
-- mlb_market_type = 'batter_runs_scored'                 (runs_scored only)
-- AND breakdown IS NOT NULL                              (only picks with source data)
-- AND each column UPDATE gated by `IS NULL` per column
-- AND breakdown ? '<key>'                                 (only when breakdown has the key)
--
-- ONLY THE 5 BACKFILLABLE COLUMNS are written. Other markets not touched.
-- score_recent_at_bats and score_pitcher_hr_rate stay NULL (no source data).
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────
-- This UPDATE writes values from existing breakdown JSONB into new columns.
-- It does NOT modify breakdown. Rollback options:
--   1. Re-NULL the 5 columns via: UPDATE public.pick_history SET <col>=NULL
--      WHERE mlb_market_type='batter_runs_scored'.
--   2. Just leave it — values are correct (match breakdown).
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────────────
-- The `WHERE X IS NULL` gate makes this idempotent.

BEGIN;

UPDATE public.pick_history
SET score_batter_hit_rate = (breakdown->>'score_batter_hit_rate')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_hit_rate'
  AND score_batter_hit_rate IS NULL;

UPDATE public.pick_history
SET score_batter_form = (breakdown->>'score_batter_form')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_form'
  AND score_batter_form IS NULL;

UPDATE public.pick_history
SET score_opposing_pitcher_quality = (breakdown->>'score_opposing_pitcher_quality')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_opposing_pitcher_quality'
  AND score_opposing_pitcher_quality IS NULL;

UPDATE public.pick_history
SET score_batter_power_rate = (breakdown->>'score_batter_power_rate')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_power_rate'
  AND score_batter_power_rate IS NULL;

UPDATE public.pick_history
SET score_batter_form_power = (breakdown->>'score_batter_form_power')::NUMERIC
WHERE mlb_market_type = 'batter_runs_scored'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_form_power'
  AND score_batter_form_power IS NULL;

COMMIT;
