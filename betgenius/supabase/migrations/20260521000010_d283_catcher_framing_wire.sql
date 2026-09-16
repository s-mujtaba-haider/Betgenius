-- D-283 SHIP 1 (2026-05-21) — re-enable catcher_framing factor.
--
-- D-282 rolled back to 0.0 because the original wire targeted
-- entity_type='Tm' rows (unavailable due to Baseball Savant
-- sanitization). D-283 ships the real wire:
--   1. Boxscore lookup of starting catcher per game via
--      MLB Stats API /game/{gamePk}/boxscore (position.abbreviation
--      = 'C' + battingOrder ending in '00').
--   2. cache_statcast_framing lookup by entity_id (=MLBAMID) with
--      entity_type='Cat'.
--   3. Pitcher's own-team catcher provides framing rv_tot →
--      bucket-scored ±6 in scorePitcherStrikeouts.
--
-- Bucket thresholds retuned for per-catcher distribution
-- (range roughly [-4.5, +4.1] for catchers with ≥500 pitches).
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_catcher_framing = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_catcher_framing = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_catcher_framing IS
  'D-283 SHIP 1 WIRED: per-catcher framing rv_tot from '
  'cache_statcast_framing (entity_type=Cat). Game-day starting '
  'catcher resolved via boxscore. Bucket ±6 on signed rv_tot. '
  'Gated ≥500 pitches. Weight 1.0.';
