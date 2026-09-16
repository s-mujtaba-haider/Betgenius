-- D-381 SHIP 1 — add odds_by_book JSONB column to recommendations_cache.
--
-- Stores the per-book price comparison data for line shopping. Each row's
-- odds_by_book is an array of {book, line, price, side} objects ordered
-- with hardrockbet first (per BOOKMAKER_PRIORITY in fetch-odds-mlb), then
-- alphabetical for books not in the priority list.
--
-- The PRIMARY pick (the algorithm's chosen book/line/odds) remains in the
-- existing line/odds/bookmaker columns. The new odds_by_book column carries
-- the SAME-LINE comparison rows from other books (or null for legacy rows
-- and any rec where multi-book collection isn't applicable, e.g., pre-D-381
-- rows or NBA).
--
-- pick_history is NOT touched — the resolution / optimizer table only cares
-- about the primary pick's outcome; multi-book data is display-only.
--
-- Rollback:
--   ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS odds_by_book;

BEGIN;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS odds_by_book JSONB;

COMMENT ON COLUMN public.recommendations_cache.odds_by_book IS
'D-381: per-book line/price comparison data for line shopping. Array of
{book, line, price, side} objects. Primary pick (algorithm-chosen book/
line/odds) remains in line/odds/bookmaker columns. odds_by_book holds the
SAME-LINE alternates from other books, ordered hardrockbet first per
BOOKMAKER_PRIORITY then alphabetically. NULL for pre-D-381 rows and any
rec where multi-book data isn''t collected (e.g., NBA).';

COMMIT;
