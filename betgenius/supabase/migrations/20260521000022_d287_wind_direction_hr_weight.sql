-- D-287 SHIP 1 (2026-05-22) — enable wind_direction_hr factor weight.
--
-- Wired in scoreBatterMarket (HR market only): cos-of-delta between
-- today's wind direction (Open-Meteo via fetch-weather, FROM-convention
-- degrees) and ballpark CF compass bearing (cache_mlb_ballpark_orientation).
-- Scaled by wind speed (5/10/15 mph thresholds). Domed parks return 0.
--
-- Bucket math (gated wind ≥5 mph, outdoor only):
--   score = cos(delta-to-CF) × speed_multiplier
--   ≥+0.6 → +6 (wind blowing OUT to CF, strong)
--   ≥+0.3 → +3
--   ≥+0.15 → +1
--   ≤-0.6 → -6 (wind blowing IN from CF, strong)
--   ≤-0.3 → -3
--   ≤-0.15 → -1
--
-- Rollback:
--   UPDATE public.algorithm_weights SET w_mlb_wind_direction_hr = 0.0 WHERE id = 1;

UPDATE public.algorithm_weights
SET w_mlb_wind_direction_hr = 1.0
WHERE id = 1;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_wind_direction_hr IS
  'D-287 SHIP 1 WIRED: HR-market wind × ballpark factor. cos-of-delta '
  'between wind direction and CF compass bearing × speed multiplier. '
  'Gated ≥5 mph + outdoor. Data: cache_mlb_game_scoreboard.weather_wind_dir_deg '
  '+ cache_mlb_ballpark_orientation. Weight 1.0.';
