-- D-136 Tier 2 #7 — score_low_min_risk schema additions.
-- CEO §19.3 approval recorded for the SHIP.
-- Pre-audit confirmed clean (migration 20260513000040):
--   pick_history %low_min% cols: 0
--   algorithm_weights %low_min% cols: 0
--   recommendations_cache %low_min% cols: 0
-- Paired verification trail: 20260514000004_low_min_risk_verification.sql
-- =============================================================================

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_low_min_risk INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pick_history.score_low_min_risk IS
  'D-136 Tier 2 #7 (May 13, 2026). Penalty (negative on over side, positive '
  'on under side via side-flip) when L5 minutes avg / season minutes avg is '
  '< 0.75. Three magnitude bands: -6 (ratio < 0.75), -10 (< 0.65), -15 (< 0.5). '
  'Requires >=10 games in gameLog and l5Avg > 0 to fire. Independent of '
  'score_min_floor (absolute threshold) and score_minutes_trend (L5 vs L10 '
  'directional). Addresses Failure Mode A (hot streak chase) directly.';

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_low_min_risk NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.recommendations_cache.score_low_min_risk IS
  'Mirror of pick_history.score_low_min_risk. D-136 May 13, 2026.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_low_min_risk NUMERIC NOT NULL DEFAULT 1.0
    CHECK (w_low_min_risk >= 0);

COMMENT ON COLUMN public.algorithm_weights.w_low_min_risk IS
  'Multiplier on score_low_min_risk before adding to finalScore. Starting '
  'value 1.0 per CEO "gut-bucket" philosophy. Re-tune after 2 weeks of '
  'organic data via D-118 calibration loop.';
