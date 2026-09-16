-- D-792 — Complete the D-790 backfill: populate the 7 D-758 top-level factor
-- columns on batter_total_bases picks from existing `breakdown` JSONB.
--
-- D-790 backfilled the 10 D-785 columns on TB picks but did NOT touch the 13
-- D-758 columns. D-791 flagged 7 of those 13 as 100% NULL on the cohort and
-- DROPPED them from the tune — leading to an incomplete-model "no edge"
-- verdict. D-792 closes the gap so the re-tune can use the full factor set.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────
-- D-791 identified 7 D-758 columns at 100% NULL on the consistent-model
-- cohort (the rest of the D-758 13 had partial coverage or non-NULL):
--   score_batter_hit_rate
--   score_batter_form
--   score_opposing_pitcher_quality
--   score_recent_at_bats
--   score_batter_power_rate
--   score_batter_form_power
--   score_pitcher_hr_rate
--
-- Pre-flight check on 500 TB picks with breakdown:
--   score_batter_hit_rate:          100.0% present, 0% non-zero (deterministically 0 on TB)
--   score_batter_form:              100.0% present, 0% non-zero (deterministically 0 on TB)
--   score_opposing_pitcher_quality: 100.0% present, 79% non-zero  ← signal
--   score_recent_at_bats:           100.0% present, 67% non-zero  ← signal
--   score_batter_power_rate:        100.0% present, 78% non-zero  ← signal
--   score_batter_form_power:        100.0% present, 67% non-zero  ← signal
--   score_pitcher_hr_rate:          100.0% present, 53% non-zero  ← signal
--
-- 5 of the 7 columns carry signal (non-zero on the majority of picks).
-- The 2 deterministically-zero columns (hit_rate, form) are still backfilled
-- because writing 0 from breakdown is the scorer's actual output for TB —
-- NOT fabrication (per D-792 brief: "where they genuinely exist as 0 in
-- breakdown, that's the real scorer return, not a forced value").
--
-- WHEN
-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-27 (D-792). Pre-D-792-backfill picks span 2026-04-29 → 2026-06-27.
-- Post-D-758 column-addition (2026-06-25) picks already have these columns
-- populated where the post-D-758 payload extension was active. The `IS NULL`
-- gate per column makes this idempotent and prevents touching post-D-758
-- already-populated rows.
--
-- SCOPE
-- ─────────────────────────────────────────────────────────────────────
-- mlb_market_type = 'batter_total_bases'                 (TB only)
-- AND breakdown IS NOT NULL                              (only picks with source data)
-- AND each column UPDATE gated by `IS NULL` on that      (skip already-populated rows)
--     specific column individually
-- AND breakdown ? '<key>'                                 (only when breakdown has the key)
--
-- ONLY THE 7 D-758 COLUMNS ARE WRITTEN. Pure additive. Other columns preserved.
-- Other markets (runs_scored, hits, hr, rbi, strikeouts) not touched.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────
-- This UPDATE writes values from existing breakdown JSONB into new columns.
-- It does NOT modify breakdown. Rollback options:
--   1. Re-NULL the 7 columns via: UPDATE public.pick_history SET <col>=NULL
--      WHERE mlb_market_type='batter_total_bases'.
--   2. Just leave it — the values are CORRECT (they match breakdown). The
--      backfill aligns pre-D-758 rows with the post-D-758 emission pattern.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────────────
-- The `WHERE X IS NULL` gate makes this idempotent. Re-running does nothing.

BEGIN;

UPDATE public.pick_history
SET score_batter_hit_rate = (breakdown->>'score_batter_hit_rate')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_hit_rate'
  AND score_batter_hit_rate IS NULL;

UPDATE public.pick_history
SET score_batter_form = (breakdown->>'score_batter_form')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_form'
  AND score_batter_form IS NULL;

UPDATE public.pick_history
SET score_opposing_pitcher_quality = (breakdown->>'score_opposing_pitcher_quality')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_opposing_pitcher_quality'
  AND score_opposing_pitcher_quality IS NULL;

UPDATE public.pick_history
SET score_recent_at_bats = (breakdown->>'score_recent_at_bats')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_recent_at_bats'
  AND score_recent_at_bats IS NULL;

UPDATE public.pick_history
SET score_batter_power_rate = (breakdown->>'score_batter_power_rate')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_power_rate'
  AND score_batter_power_rate IS NULL;

UPDATE public.pick_history
SET score_batter_form_power = (breakdown->>'score_batter_form_power')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_batter_form_power'
  AND score_batter_form_power IS NULL;

UPDATE public.pick_history
SET score_pitcher_hr_rate = (breakdown->>'score_pitcher_hr_rate')::NUMERIC
WHERE mlb_market_type = 'batter_total_bases'
  AND breakdown IS NOT NULL
  AND breakdown ? 'score_pitcher_hr_rate'
  AND score_pitcher_hr_rate IS NULL;

COMMIT;
