-- D-340 / T6 — add algorithm_weights columns for MLB W / W_BATTER / W_GAME constants.
--
-- Current state (per D-301 + D-340 SHIP 1 inventory):
-- - 33 weight constants hardcoded in scoring_mlb_v2.ts across W, W_BATTER, W_GAME objects
-- - 24 existing w_mlb_* columns in algorithm_weights (D-274/D-276/D-278/D-280/D-281/D-286)
-- - ~3 overlap (lineup_vs_hand_split + 2 placeholders); 30 TS constants need new columns
--
-- All default values match CURRENT TS literal values — behaviorally identical to pre-D-340.
-- T6 is about making the read mechanism DB-driven, NOT changing values (per spec).
--
-- Rollback: ALTER TABLE algorithm_weights DROP COLUMN w_mlb_X (per column).

-- === Pitcher_k scorer weights (W object, scoring_mlb_v2.ts:145-156) ===
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_k_rate            NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_form              NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_opposing_lineup_k         NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_handedness_matchup        NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_pitch_count_trend         NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_rest_pitcher              NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_ballpark_factor   NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_weather_wind      NUMERIC NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_weather_temp      NUMERIC NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_umpire_k_zone     NUMERIC NOT NULL DEFAULT 0.75;

-- === Batter market scorer weights (W_BATTER object, scoring_mlb_v2.ts:712-726) ===
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_hit_rate               NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_form                   NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_pitcher_quality        NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_recent_ab              NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_handedness_matchup     NUMERIC NOT NULL DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_ballpark_hits_factor   NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_weather_temp           NUMERIC NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_lineup_consistency     NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_power_rate             NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_form_power             NUMERIC NOT NULL DEFAULT 1.25,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_pitcher_hr_rate        NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_weather_wind           NUMERIC NOT NULL DEFAULT 0.5;

-- === Game-market scorer weights (W_GAME object, scoring_mlb_v2.ts:1431-1443) ===
-- Note: w_mlb_lineup_vs_hand_split already exists (added D-285); skip if present.
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_game_offense_diff           NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_game_pitching_matchup       NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_game_bullpen_strength       NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_game_recent_run_diff        NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_game_h2h_recent             NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_game_team_form              NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_game_ballpark               NUMERIC NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_game_weather_wind           NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_game_weather_temp           NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_game_umpire_k_zone          NUMERIC NOT NULL DEFAULT 0.75;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_k_rate IS
  'D-340 T6. Multiplier for score_pitcher_k_rate in scorePitcherStrikeouts. '
  'Source: scoring_mlb_v2.ts:146 W.pitcherKRate. Default 1.5 preserves pre-D-340 behavior.';
