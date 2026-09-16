-- D-498 (2026-06-09) — Capture the 8 D-347/D-348/D-349/D-354 weight values
-- BEFORE the deploy of the extended ALL_WEIGHTS, so SHIP 2 step C can prove
-- "values unchanged" by re-querying after deploy and comparing. READ-ONLY —
-- RAISE NOTICE only; no UPDATE, no INSERT, no schema change.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-498] BEFORE deploy — current values of 8 newly-tunable weights:';
  FOR r IN
    SELECT
      w_mlb_lineup_spot,
      w_mlb_day_after_night_fatigue,
      w_mlb_travel_getaway,
      w_mlb_pitcher_command_trend,
      w_mlb_pitcher_velocity_trend,
      w_mlb_pitcher_baa_vs_hand,
      w_mlb_lineup_k_composition,
      w_mlb_hitter_streak_fatigue
    FROM public.algorithm_weights
    WHERE id = 1
  LOOP
    RAISE NOTICE 'w_mlb_lineup_spot               = %', r.w_mlb_lineup_spot;
    RAISE NOTICE 'w_mlb_day_after_night_fatigue   = %', r.w_mlb_day_after_night_fatigue;
    RAISE NOTICE 'w_mlb_travel_getaway            = %', r.w_mlb_travel_getaway;
    RAISE NOTICE 'w_mlb_pitcher_command_trend     = %', r.w_mlb_pitcher_command_trend;
    RAISE NOTICE 'w_mlb_pitcher_velocity_trend    = %', r.w_mlb_pitcher_velocity_trend;
    RAISE NOTICE 'w_mlb_pitcher_baa_vs_hand       = %', r.w_mlb_pitcher_baa_vs_hand;
    RAISE NOTICE 'w_mlb_lineup_k_composition      = %', r.w_mlb_lineup_k_composition;
    RAISE NOTICE 'w_mlb_hitter_streak_fatigue     = %', r.w_mlb_hitter_streak_fatigue;
  END LOOP;
END $$;
