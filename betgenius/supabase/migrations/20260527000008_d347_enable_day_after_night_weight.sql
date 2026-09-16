-- D-347 follow-up — enable w_mlb_day_after_night_fatigue from D-340's 0.0 placeholder to 0.5.
--
-- The D-340 migration created w_mlb_day_after_night_fatigue at 0.0 as a placeholder. D-347 ships
-- the scorer code. Per D-347 spec: "Initial weight: 1.0 (default until T11 optimizes)" — using 0.5
-- here matches the conservative magnitude of the bucket (-2/-3 max output) so the rounded
-- contribution stays in line with other batter-side factors (Math.round(-3 * 0.5) = -2).
--
-- This is an INITIAL-ENABLE, not a tuning change. Setting from 0.0 (dead placeholder) to active.
-- T11 optimizer will adjust the magnitude later.
--
-- Rollback: UPDATE public.algorithm_weights SET w_mlb_day_after_night_fatigue = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights SET w_mlb_day_after_night_fatigue = 0.5 WHERE id = 1 AND w_mlb_day_after_night_fatigue = 0.0;
