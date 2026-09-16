-- D-285 SHIP 1 (2026-05-21) — enable lineup_vs_hand_split factor weight.
--
-- Team-platoon factor in scoreGameMarket: each team's PA-weighted
-- lineup OPS vs the OPPOSING starter's pitching hand. Aggregator
-- pre-runs once at start of process-games-mlb run via
-- preloadLineupVsHand (D-284 architecture pattern — zero per-pick
-- DB calls during scoring).
--
-- Data source: cache_mlb_batter_splits (D-282 SHIP 1 cache,
-- D-283 SHIP 3 daily-refreshed) + boxscore startingLineup
-- (battingOrder X00) for game-day lineup identification.
--
-- Bucket thresholds:
--   Total market — combined home+away matchup OPS vs 2×0.720 baseline
--     ±0.040 / ±0.080 / ±0.160 → ±1/±3/±6
--   Side market — home_matchup_ops - away_matchup_ops differential
--     ±0.025 / ±0.050 / ±0.100 → ±1/±3/±6
--
-- Gated: requires both teams' lineup_pa ≥100 (signal floor) AND
-- both starting pitchers' hand known.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_lineup_vs_hand_split = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_lineup_vs_hand_split = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_lineup_vs_hand_split IS
  'D-285 SHIP 1 WIRED: team-platoon OPS aggregate vs opposing SP hand. '
  'PA-weighted across starting lineup batters from cache_mlb_batter_splits. '
  'Bucket ±6 on combined OPS (total market) or OPS diff (side market). '
  'Gated ≥100 PA per team. Weight 1.0.';
