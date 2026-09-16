-- D-282 SHIP 2 (2026-05-21) — enable catcher_framing factor weight.
--
-- The factor reads cache_statcast_framing (entity_type='Tm') via
-- caches.teamFraming(pitcher.team) in process-games-mlb. Pitcher's
-- own team's catcher frames for him.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_catcher_framing = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_catcher_framing = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_catcher_framing IS
  'D-282 SHIP 2 WIRED: team-aggregate framing rv_tot from '
  'cache_statcast_framing (entity_type=Tm). Bucket ±6 by signed '
  'run-value. Gated ≥500 pitches. Default 1.0.';
