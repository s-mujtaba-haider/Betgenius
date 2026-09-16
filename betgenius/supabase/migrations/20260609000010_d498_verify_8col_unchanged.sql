-- D-498 SHIP 2 step C — capture the 8 newly-tunable weight values AFTER the
-- optimize-weights-mlb deploy. Compared in d498_verify.md against the BEFORE
-- snapshot captured by migration 20260609000009. PASS = identical values
-- (this batch added tunability only; no UPDATE was issued).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-498] AFTER deploy — values of 8 newly-tunable weights (must match BEFORE):';
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
