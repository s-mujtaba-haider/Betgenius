-- C33 Phase 3 — recommendations_cache.game_date TEXT → DATE migration
--
-- Pre-flight verification (CEO ran May 7):
--   recommendations_cache.game_date data_type=text, is_nullable=NO, 4,144 rows
--   range 20260414 - 20260506, zero malformed values
--
-- The NOT NULL constraint on the existing TEXT column doesn't block this
-- additive migration — it adds a new nullable column game_date_new DATE.
-- Phase 6 will: (1) ALTER COLUMN game_date_new SET NOT NULL after writer
-- dual-write window proves zero NULLs accumulating, then (2) drop OLD
-- column and rename. Same gradual cutover pattern as pick_history.

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS game_date_new DATE;

UPDATE public.recommendations_cache
SET game_date_new = TO_DATE(game_date, 'YYYYMMDD')
WHERE game_date IS NOT NULL
  AND game_date ~ '^[0-9]{8}$'
  AND game_date_new IS NULL;

CREATE INDEX IF NOT EXISTS idx_recommendations_cache_game_date_new
  ON public.recommendations_cache (game_date_new);

COMMENT ON COLUMN public.recommendations_cache.game_date_new IS
  'C33 transitional column. DATE-typed mirror of game_date (TEXT YYYYMMDD). '
  'Writers dual-write to both during transition window. Phase 6 drops '
  'game_date and renames game_date_new → game_date.';
