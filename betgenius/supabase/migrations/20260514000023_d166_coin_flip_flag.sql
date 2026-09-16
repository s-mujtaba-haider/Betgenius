-- D-166 coin-flip season hit rate sanity check (May 14, 2026)
--
-- Picks with ~50% season hit rates landing in Elite (80+) tier signal
-- that some factor is artificially pumping confidence — either a real bug
-- or a structural over-weighting issue. Flag for later review.
--
-- Predicate: finalScore >= 80 AND 40% <= season_hit_rate <= 60%
--
-- Computed in scoreOneSide. Persisted as coin_flip_flag BOOLEAN on
-- pick_history + recommendations_cache. Dashboard surfaces a small
-- indicator with a tooltip. Performance page counts %-of-Elite over
-- rolling 30 days — >10% is an investigation signal.
--
-- Closes D-148 §15.10 #7.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS coin_flip_flag BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS coin_flip_flag BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.pick_history.coin_flip_flag IS
  'D-166: TRUE when confidence >= 80 AND season_hit_pct in [40, 60]. Sanity check — signals possible factor pumping.';
COMMENT ON COLUMN public.recommendations_cache.coin_flip_flag IS
  'D-166: TRUE when confidence >= 80 AND season_hit_pct in [40, 60]. Sanity check — signals possible factor pumping.';

-- Backfill: recompute for existing rows where we have season_hit_pct.
-- Both columns are NOT NULL DEFAULT FALSE so no row update is needed for
-- coin_flip_flag=FALSE cases. Only flip TRUE where predicate matches.
UPDATE public.pick_history
SET coin_flip_flag = TRUE
WHERE confidence >= 80
  AND season_hit_pct IS NOT NULL
  AND season_hit_pct >= 40
  AND season_hit_pct <= 60
  AND coin_flip_flag = FALSE;

UPDATE public.recommendations_cache
SET coin_flip_flag = TRUE
WHERE confidence >= 80
  AND season_hit_pct IS NOT NULL
  AND season_hit_pct >= 40
  AND season_hit_pct <= 60
  AND coin_flip_flag = FALSE;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- ALTER TABLE public.pick_history DROP COLUMN IF EXISTS coin_flip_flag;
-- ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS coin_flip_flag;
