-- D-278-FACTORS (2026-05-21) — enable 3 additional Statcast factors.
--
-- D-276 wired 3 factors. D-278 wires 3 more (batter_xba, batter_exit_velo_trend,
-- pitcher_baa). Total wired = 6 of 22. Remaining 16 stay as zero-weight
-- placeholders with documented data-source gaps in d278_factor_gaps.md.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_batter_xba = 0.0,
--     w_mlb_batter_exit_velo_trend = 0.0, w_mlb_pitcher_baa = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET
  w_mlb_batter_xba              = 1.0,
  w_mlb_batter_exit_velo_trend  = 1.0,
  w_mlb_pitcher_baa             = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_xba IS
  'D-278-FACTORS WIRED: batter xBA (expected BA) vs league avg 0.245. Reads via _shared/statcast.ts getBatterStatcast().est_ba. Bucket-based ±6. Default 1.0.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_exit_velo_trend IS
  'D-278-FACTORS WIRED: batter avg exit velocity vs league avg ~89 mph. Power signal for HR/TB/RBI. Bucket-based ±6. Default 1.0.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_baa IS
  'D-278-FACTORS WIRED: pitcher BAA-allowed proxied via est_ba. Bucket-based ±6 (lower BAA = K friendly). Default 1.0.';
