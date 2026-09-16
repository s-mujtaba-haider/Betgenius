-- D-284 SHIP 2 (2026-05-21) — enable pitcher_hr_per_9 factor weight.
--
-- New HR-market-only deep-signal factor wired in scoreBatterMarket.
-- Complementary to existing score_pitcher_hr_rate (which fires for
-- all power markets with ratio buckets vs LEAGUE_AVG_HR_PER_9). The
-- new factor uses absolute-value buckets specifically tuned to HR
-- market signal density.
--
--   pitcher HR/9 ≥1.8 → +6 (home-run-prone, boost over)
--   pitcher HR/9 ≥1.4 → +3
--   pitcher HR/9 ≥1.1 → +1
--   pitcher HR/9 ≤1.0 → -1 (mild stingy)
--   pitcher HR/9 ≤0.9 → -3
--   pitcher HR/9 ≤0.6 → -6 (home-run-stingy, suppress over)
--
-- Gated ≥30 IP. Applies marketStat='homeRuns' only.
-- Data source: OpposingPitcherContext.hrPerNine (already populated
-- via fetchPitcherSeasonAsOpposing in process-games-mlb).
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_pitcher_hr_per_9 = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_pitcher_hr_per_9 = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_hr_per_9 IS
  'D-284 SHIP 2 WIRED: HR-market-only factor on opposing pitcher '
  'HR/9. Absolute-value buckets ±6 (1.8/1.4/1.1/1.0/0.9/0.6 thresholds). '
  'Gated ≥30 IP. Complementary to score_pitcher_hr_rate (power-markets '
  'broad signal). Weight 1.0.';
