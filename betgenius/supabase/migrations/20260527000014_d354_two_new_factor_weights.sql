-- D-354 — two new batter/pitcher factors.
--
-- hitter_streak_fatigue (batter-side): consecutive-starts penalty.
--   New column. Initial weight 0.5 — modest factor magnitude ±2 max.
--
-- lineup_k_composition (pitcher-side): position-weighted opposing lineup K rate.
--   D-340 placeholder column existed at 0.0; raise to 1.0 (active).
--   Magnitude ±6 max, weight 1.0 → ±6 contribution at extreme buckets.
--
-- Rollback:
--   ALTER TABLE algorithm_weights DROP COLUMN w_mlb_hitter_streak_fatigue;
--   UPDATE algorithm_weights SET w_mlb_lineup_k_composition = 0.0 WHERE id = 1;

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_hitter_streak_fatigue NUMERIC NOT NULL DEFAULT 0.5;

UPDATE public.algorithm_weights SET w_mlb_lineup_k_composition = 1.0 WHERE id = 1 AND w_mlb_lineup_k_composition = 0.0;
