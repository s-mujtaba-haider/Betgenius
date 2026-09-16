-- D-616 SHIP 1 — add input hash to mlb_scoring_progress so process-games-mlb
-- can skip games whose pick-affecting inputs haven't changed since last score.
--
-- Hash inputs (per d616 doc): props (line/odds/pick_side/prop_type/player/bookmaker),
-- lineup PIDs (home+away), starting pitcher IDs, weather snapshot.
-- All inputs that legitimately change a pick's score. SHA-1 truncated to 16 hex
-- chars — zero collision risk for our scale (9 games × 288 ticks/day = ~2.5K
-- checks; SHA-1-16 = 64-bit space).
--
-- Backward-compatible: existing rows get NULL; the skip path treats NULL as
-- "never seen this hash" → score normally (err toward scoring per spec).

ALTER TABLE public.mlb_scoring_progress
  ADD COLUMN IF NOT EXISTS last_score_hash text;

COMMENT ON COLUMN public.mlb_scoring_progress.last_score_hash IS
  'D-616 (2026-06-19). SHA-1[0:16] of (props × lineup × pitchers × weather) '
  'for the game on game_date. process-games-mlb compares the current input '
  'hash to this cached value; matches mean skip (no scoring, no Sonnet). '
  'NULL = never scored under D-616, force a score. Includes ALL pick-affecting '
  'inputs — err toward re-scoring if the hash CAN''T be computed.';
