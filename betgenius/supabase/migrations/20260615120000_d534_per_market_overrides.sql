-- D-534 SHIP 2.1 — Per-market weight overrides column.
--
-- Design: single JSONB column on the existing algorithm_weights row.
-- Default '{}' (empty object) means no overrides → every market uses the
-- existing global weight columns (w_mlb_*) → BYTE-IDENTICAL scoring.
--
-- Shape when populated (Phase B):
--   {
--     "batter_hits":          { "w_mlb_batter_handedness_matchup": -1.5, ... },
--     "batter_total_bases":   { ... },
--     "batter_hr":            { ... },
--     "batter_rbis":          { ... },
--     "batter_strikeouts":    { ... },
--     "batter_runs_scored":   { ... },
--     "pitcher_k":            { ... },
--     "pitcher_outs":         { ... },
--     "game_side":            { ... },
--     "game_total":           { ... }
--   }
--
-- Keys inside each market's object are DB column names (the same names
-- the loader already reads for the global values). Values are numeric
-- overrides for THAT market only.
--
-- Loader semantics:
--   perMarketWeights[market][weight_name] = override[market]?[weight_name]
--                                           ?? global[weight_name]
--
-- Rollback: DROP COLUMN mlb_market_weight_overrides.
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS mlb_market_weight_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Sanity: confirm row 1 has the default empty object (no accidental seed)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT mlb_market_weight_overrides AS o,
           jsonb_typeof(mlb_market_weight_overrides) AS t,
           jsonb_object_keys(mlb_market_weight_overrides) AS k
    FROM public.algorithm_weights WHERE id = 1
  LOOP RAISE NOTICE '[D-534 §A] row 1 overrides: type=% has_key=%', r.t, r.k; END LOOP;

  -- One single NOTICE if no keys (empty object)
  FOR r IN
    SELECT count(*) AS keys FROM jsonb_object_keys(
      (SELECT mlb_market_weight_overrides FROM public.algorithm_weights WHERE id = 1)
    )
  LOOP RAISE NOTICE '[D-534 §A] row 1 overrides key count = %', r.keys; END LOOP;
END $$;
