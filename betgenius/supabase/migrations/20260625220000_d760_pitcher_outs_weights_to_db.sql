-- D-760 STEP 1 — Move pitcher_outs weights from LITERALS to DB-tunable.
--
-- Per D-759 audit: scorePitcherOuts had 17 hardcoded literal multipliers in
-- the scorer body. D-760 wires them to DEFAULT_W keys and the loader. This
-- migration adds the 17 algorithm_weights columns + seeds them at the EXACT
-- literal values that were hardcoded.
--
-- §19.3: zero weight VALUE change. The literals were:
--   outs_pitcher_avg_ip = 1.5            (matches DEFAULT_W.outsPitcherAvgIp = 1.5)
--   outs_pitcher_recent_ip_trend = 1.0   (matches DEFAULT_W.outsPitcherRecentIpTrend = 1.0)
--   outs_pitcher_volatility_v2 = 0.75    (matches DEFAULT_W.outsPitcherVolatilityV2 = 0.75)
--   outs_rest_pitcher = 0.75             (matches DEFAULT_W.outsRestPitcher = 0.75)
--   outs_pitcher_walk_efficiency = 0.75
--   outs_pitcher_recent_pitch_count = 1.0
--   outs_first_inning_trouble = 1.0
--   outs_bullpen_game_or_opener = 1.5
--   outs_own_pen_rest = 1.0
--   outs_game_script_risk = 1.0
--   outs_opp_k_rate = 1.0
--   outs_opp_obp_patience = 1.0
--   outs_opp_walk_rate = 0.75
--   outs_opp_pitch_grind = 0.75
--   outs_opp_chase_rate = 1.0
--   outs_ballpark_factor = 1.0
--   outs_weather_temp = 0.5
--
-- Loader already wired (mlb_weights.ts:241+). D-755 build guard catches any
-- omission. D-758 build guard catches any RPC mismatch (these columns
-- aren't in pick_history hist_payload — they're algorithm_weights columns,
-- so D-758 is irrelevant here).
--
-- Post-migration: algorithm_weights.updated_at WILL bump (column adds touch
-- the row). All weight VALUES stay byte-identical to the literals — the move
-- is structural.

ALTER TABLE algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitcher_avg_ip             NUMERIC DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitcher_recent_ip_trend    NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitcher_volatility_v2      NUMERIC DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_rest_pitcher               NUMERIC DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitcher_walk_efficiency    NUMERIC DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitcher_recent_pitch_count NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_first_inning_trouble       NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_bullpen_game_or_opener     NUMERIC DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_own_pen_rest               NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_game_script_risk           NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_opp_k_rate                 NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_opp_obp_patience           NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_opp_walk_rate              NUMERIC DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_opp_pitch_grind            NUMERIC DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_opp_chase_rate             NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_ballpark_factor            NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_weather_temp               NUMERIC DEFAULT 0.5;

-- Backfill row 1 with the same seed values (idempotent — DEFAULT covers new inserts).
UPDATE algorithm_weights SET
  w_mlb_outs_pitcher_avg_ip             = COALESCE(w_mlb_outs_pitcher_avg_ip,             1.5),
  w_mlb_outs_pitcher_recent_ip_trend    = COALESCE(w_mlb_outs_pitcher_recent_ip_trend,    1.0),
  w_mlb_outs_pitcher_volatility_v2      = COALESCE(w_mlb_outs_pitcher_volatility_v2,      0.75),
  w_mlb_outs_rest_pitcher               = COALESCE(w_mlb_outs_rest_pitcher,               0.75),
  w_mlb_outs_pitcher_walk_efficiency    = COALESCE(w_mlb_outs_pitcher_walk_efficiency,    0.75),
  w_mlb_outs_pitcher_recent_pitch_count = COALESCE(w_mlb_outs_pitcher_recent_pitch_count, 1.0),
  w_mlb_outs_first_inning_trouble       = COALESCE(w_mlb_outs_first_inning_trouble,       1.0),
  w_mlb_outs_bullpen_game_or_opener     = COALESCE(w_mlb_outs_bullpen_game_or_opener,     1.5),
  w_mlb_outs_own_pen_rest               = COALESCE(w_mlb_outs_own_pen_rest,               1.0),
  w_mlb_outs_game_script_risk           = COALESCE(w_mlb_outs_game_script_risk,           1.0),
  w_mlb_outs_opp_k_rate                 = COALESCE(w_mlb_outs_opp_k_rate,                 1.0),
  w_mlb_outs_opp_obp_patience           = COALESCE(w_mlb_outs_opp_obp_patience,           1.0),
  w_mlb_outs_opp_walk_rate              = COALESCE(w_mlb_outs_opp_walk_rate,              0.75),
  w_mlb_outs_opp_pitch_grind            = COALESCE(w_mlb_outs_opp_pitch_grind,            0.75),
  w_mlb_outs_opp_chase_rate             = COALESCE(w_mlb_outs_opp_chase_rate,             1.0),
  w_mlb_outs_ballpark_factor            = COALESCE(w_mlb_outs_ballpark_factor,            1.0),
  w_mlb_outs_weather_temp               = COALESCE(w_mlb_outs_weather_temp,               0.5)
WHERE id = 1;

DO $$
DECLARE
  expected NUMERIC[] := ARRAY[1.5, 1.0, 0.75, 0.75, 0.75, 1.0, 1.0, 1.5, 1.0, 1.0, 1.0, 1.0, 0.75, 0.75, 1.0, 1.0, 0.5];
  actual   NUMERIC[];
BEGIN
  SELECT ARRAY[
    w_mlb_outs_pitcher_avg_ip, w_mlb_outs_pitcher_recent_ip_trend, w_mlb_outs_pitcher_volatility_v2,
    w_mlb_outs_rest_pitcher, w_mlb_outs_pitcher_walk_efficiency, w_mlb_outs_pitcher_recent_pitch_count,
    w_mlb_outs_first_inning_trouble, w_mlb_outs_bullpen_game_or_opener, w_mlb_outs_own_pen_rest,
    w_mlb_outs_game_script_risk, w_mlb_outs_opp_k_rate, w_mlb_outs_opp_obp_patience,
    w_mlb_outs_opp_walk_rate, w_mlb_outs_opp_pitch_grind, w_mlb_outs_opp_chase_rate,
    w_mlb_outs_ballpark_factor, w_mlb_outs_weather_temp
  ] INTO actual FROM algorithm_weights WHERE id = 1;
  IF actual <> expected THEN
    RAISE EXCEPTION 'D-760 post-migration check failed: seed values do not match literals. expected=% actual=%', expected, actual;
  END IF;
  RAISE NOTICE 'D-760 all 17 pitcher_outs weight columns added + seeded at exact literal values';
END $$;
