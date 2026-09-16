-- D-362 SHIP 2 — add the 1 missing w_mlb_* column flagged by SHIP 1 inventory.
--
-- Per d362_inventory.md the other 12 D-301-flagged columns already exist in
-- algorithm_weights from D-340. Only w_mlb_batter_vs_pitcher_hand_split is
-- missing — adding it here with DEFAULT 1.0 NOT NULL so the loader fallback
-- matches the current hardcoded literal at scoring_mlb_v2.ts:1437.
--
-- Behavior preservation: the literal `* 1.0` site stays effectively `* 1.0`
-- after SHIP 3 replaces it with `* W_BATTER.vsPitcherHandSplit` (which reads
-- this column with fallback 1.0). T11 can later UPDATE this column.
--
-- ROLLBACK:
--   ALTER TABLE public.algorithm_weights DROP COLUMN IF EXISTS w_mlb_batter_vs_pitcher_hand_split;

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_vs_pitcher_hand_split NUMERIC NOT NULL DEFAULT 1.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_vs_pitcher_hand_split IS
  'D-362 / D-282 — weight for score_batter_vs_pitcher_hand_split factor. '
  'Default 1.0 matches the pre-D-362 hardcoded literal. T11-tunable.';
