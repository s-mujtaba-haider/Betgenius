-- D-281 SHIP 2 (2026-05-21) — enable batter_babip factor.
--
-- BABIP regression signal in batter scoring (hits/TB/RBI markets;
-- not HR since BABIP excludes home runs by definition). Data source
-- is `season.babip` already in BatterSeasonStats interface (line 528),
-- populated by the D-204 batter season stats accessor.
--
-- Bucket scoring at scoring_mlb.ts: ±5 max (regression direction
-- opposite to BABIP delta from .300 league avg).
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_batter_babip = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_batter_babip = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_babip IS
  'D-281 SHIP 2 WIRED: BABIP regression factor for batter hits/TB/RBI. '
  'Uses season.babip - .300 league avg. Bucket-based ±5. High BABIP = '
  'lucky → regression down expected. Low BABIP = unlucky → upside. '
  'Default weight 1.0.';
