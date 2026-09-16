-- D-283 SHIP 4 (2026-05-21) — enable bullpen_quality factor weight.
--
-- New factor wired in scoreBatterMarket: opposing team bullpen ERA
-- bucket-scored ±6 (gated ≥30 IP). Applies to all 4 batter markets
-- (hits, totalBases, rbi, homeRuns). Captures late-AB context when
-- starter exits and batters face the bullpen for 1-3 ABs.
--
-- Data source: cache_mlb_bullpen_stats populated by fetch-mlb-bullpen-stats
-- daily 5 AM ET cron. League avg bullpen ERA ~4.00 (2026).
--
-- Game-total markets ALREADY consume bullpen via score_bullpen_strength
-- factor (W_GAME.bullpenStrength=1.0, no algorithm_weights gate). That
-- factor was previously dead due to TeamSeasonContext.bullpenEra=null;
-- D-283 wires it via the same cache table → factor comes alive.
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_bullpen_quality = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_bullpen_quality = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_bullpen_quality IS
  'D-283 SHIP 4 WIRED: per-batter factor applying opposing team '
  'bullpen ERA to all 4 batter markets. Bucket ±6 on ERA (gated '
  '≥30 IP). Data source cache_mlb_bullpen_stats. Weight 1.0.';
