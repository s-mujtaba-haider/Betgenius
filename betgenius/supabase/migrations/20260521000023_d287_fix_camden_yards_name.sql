-- D-287 SHIP 1 (2026-05-22) — fix Camden Yards venue name to match scoreboard.
--
-- The MLB Stats API schedule returns "Oriole Park at Camden Yards" as
-- venue.name; my seed used the colloquial "Camden Yards". Rename the
-- orientation row so lookups match.
--
-- Rollback:
--   UPDATE public.cache_mlb_ballpark_orientation SET venue_name = 'Camden Yards'
--   WHERE venue_name = 'Oriole Park at Camden Yards';

UPDATE public.cache_mlb_ballpark_orientation
SET venue_name = 'Oriole Park at Camden Yards'
WHERE venue_name = 'Camden Yards';
