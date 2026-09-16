-- D-349 — weight columns for 2 new pitcher factors.
--
-- pitcher_velocity_trend: primary fastball avg velocity vs league avg ~94 mph.
--   Magnitude ±3 max, weight 1.0 → ±3 contribution.
-- pitcher_baa_vs_hand: pitcher BAA vs opposing batter's handedness.
--   Magnitude ±3 max, weight 1.0 → ±3 contribution.
--
-- Rollback: ALTER TABLE algorithm_weights DROP COLUMN w_mlb_pitcher_velocity_trend;
--          ALTER TABLE algorithm_weights DROP COLUMN w_mlb_pitcher_baa_vs_hand_d349;
-- Note: w_mlb_pitcher_baa_vs_hand already exists from D-340 (placeholder 0.0).
-- D-349 raises it to active 1.0.

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_velocity_trend NUMERIC NOT NULL DEFAULT 1.0;

-- Raise D-340 placeholder from 0.0 to 1.0 now that scorer ships.
UPDATE public.algorithm_weights SET w_mlb_pitcher_baa_vs_hand = 1.0 WHERE id = 1 AND w_mlb_pitcher_baa_vs_hand = 0.0;
