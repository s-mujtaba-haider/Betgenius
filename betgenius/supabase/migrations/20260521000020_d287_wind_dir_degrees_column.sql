-- D-287 SHIP 1 (2026-05-22) — add wind direction degrees column to scoreboard.
--
-- Existing `weather_wind_dir` column stores compass string ("NNE") with
-- 22.5° granularity. New `weather_wind_dir_deg` stores raw degrees from
-- the weather API for precise factor math (cos-of-delta vs ballpark CF
-- orientation).
--
-- Backwards compatible: existing column kept; new column nullable.
--
-- Rollback:
--   ALTER TABLE public.cache_mlb_game_scoreboard DROP COLUMN IF EXISTS weather_wind_dir_deg;

ALTER TABLE public.cache_mlb_game_scoreboard
  ADD COLUMN IF NOT EXISTS weather_wind_dir_deg INTEGER;

COMMENT ON COLUMN public.cache_mlb_game_scoreboard.weather_wind_dir_deg IS
  'D-287 SHIP 1: wind direction in compass degrees (FROM-direction per '
  'meteorology convention). Populated by fetch-weather when source API '
  'returns raw degrees (Open-Meteo). Consumed by wind_direction_hr factor.';
