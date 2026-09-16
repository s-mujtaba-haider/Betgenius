-- D-167 negative-factor stacking detection (May 14, 2026)
--
-- Failure Mode D (per D-148 audit): multiple negative factors stacking
-- shouldn't promote a pick to Elite. If a pick has 3+ factors with
-- score < 0 AND confidence >= 80, that's a red flag — some other factor
-- is over-pumping the score to compensate for clear negative signals.
--
-- Predicate computed in scoreOneSide:
--   negative_factor_count = count of breakdown values that are numeric AND < 0
--   negative_stacking_flag = finalScore >= 80 AND negative_factor_count >= 3
--
-- negative_factor_count itself is persisted (INT) so we can diagnose
-- across different thresholds without re-scoring.
--
-- Closes D-148 §15.10 #10.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS negative_stacking_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS negative_factor_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS negative_stacking_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS negative_factor_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pick_history.negative_stacking_flag IS
  'D-167: TRUE when confidence >= 80 AND negative_factor_count >= 3. Failure Mode D detection.';
COMMENT ON COLUMN public.pick_history.negative_factor_count IS
  'D-167: count of breakdown[*] entries with numeric value < 0. Used to drive negative_stacking_flag and for diagnostic queries.';
COMMENT ON COLUMN public.recommendations_cache.negative_stacking_flag IS
  'D-167: TRUE when confidence >= 80 AND negative_factor_count >= 3.';
COMMENT ON COLUMN public.recommendations_cache.negative_factor_count IS
  'D-167: count of breakdown[*] entries with numeric value < 0.';

-- Backfill: derive negative_factor_count from existing breakdown JSONB on
-- recommendations_cache (pick_history lacks the JSONB breakdown column,
-- only the discrete score_* columns — backfill there requires aggregating
-- those, deferred to a separate pass if needed).
--
-- For recommendations_cache: count the JSONB pairs where value is numeric
-- and < 0.
UPDATE public.recommendations_cache
SET
  negative_factor_count = (
    SELECT COUNT(*)
    FROM jsonb_each(breakdown) AS kv(k, v)
    WHERE jsonb_typeof(v) = 'number' AND (v::text)::numeric < 0
  ),
  negative_stacking_flag = (
    confidence >= 80 AND (
      SELECT COUNT(*)
      FROM jsonb_each(breakdown) AS kv(k, v)
      WHERE jsonb_typeof(v) = 'number' AND (v::text)::numeric < 0
    ) >= 3
  )
WHERE breakdown IS NOT NULL;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- ALTER TABLE public.pick_history DROP COLUMN IF EXISTS negative_stacking_flag;
-- ALTER TABLE public.pick_history DROP COLUMN IF EXISTS negative_factor_count;
-- ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS negative_stacking_flag;
-- ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS negative_factor_count;
