-- D-282 SHIP 1 (2026-05-21) — enable batter_vs_pitcher_hand_split.
--
-- Wired via:
--   - cache_mlb_batter_splits (D-282 migration 20260521000003)
--   - fetch-mlb-batter-splits edge function (manual trigger this batch;
--     daily cron in D-283)
--   - caches.batterSplits() accessor in process-games-mlb
--   - scoreBatterMarket() factor block in _shared/scoring_mlb.ts
--
-- Factor logic: compare batter's vs-LHP or vs-RHP split (depending on
-- today's starting pitcher hand) against batter's overall season avg.
-- Positive delta = favorable matchup. Bucket-based ±6.
-- Gated by ≥30 PA sample for statistical reliability.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_batter_vs_pitcher_hand = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_batter_vs_pitcher_hand = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_vs_pitcher_hand IS
  'D-282 SHIP 1 WIRED: batter platoon split factor. Source '
  'cache_mlb_batter_splits.vs_(lhp|rhp)_(avg|slg|ops). Compares to '
  'season overall. Bucket-based ±6, gated by ≥30 PA. Default 1.0.';
