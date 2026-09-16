-- D-381 SHIP 4 PIVOT — drop the duplicate odds_by_book column.
--
-- SHIP 0/1 missed the existing `available_books` JSONB column on
-- recommendations_cache (added in 20260428000000_path_c_step1_line_shopping_schema.sql).
-- NBA's process-games already populates it; Dashboard's LineShoppingSection
-- already renders it. I created a duplicate column via 20260531000008. This
-- migration drops it and the next round refactors process-games-mlb to write
-- to `available_books` instead, matching the established convention.
--
-- The established shape: Array<{ bookmaker, line, odds, pick_side }>
-- (NOT the {book, line, price, side} shape I designed; need to match NBA).

BEGIN;

ALTER TABLE public.recommendations_cache
  DROP COLUMN IF EXISTS odds_by_book;

COMMIT;
