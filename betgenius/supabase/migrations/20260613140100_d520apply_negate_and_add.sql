-- D-520-APPLY SHIP 1 — Negate 9 confirmed-inverted batter weights, add
-- new w_mlb_batter_line_hit_rate column (default 2.0).
--
-- HARD INVARIANT: exactly 10 changes here:
--   9 sign flips (UPDATE ... = -current)
--   1 ALTER TABLE ADD COLUMN (default 2.0)
-- Every other column byte-identical. NBA weights untouched. Non-batter MLB
-- weights untouched. The CEO-approved §19.3 change set.
--
-- Pre-apply snapshot: 20260613140000_d520apply_snapshot.sql
--                     public.algorithm_weights_d520apply_snapshot
--                     docs/loop/reports/d520apply_snapshot.json
-- Pre-apply git SHA: 4b1eb991f65d19c5ae65c76d97eb06e54b765f87
--
-- Rollback:
--   UPDATE public.algorithm_weights w SET
--     w_mlb_batter_handedness_matchup  = s.w_mlb_batter_handedness_matchup,
--     w_mlb_batter_weather_wind        = s.w_mlb_batter_weather_wind,
--     w_mlb_batter_lineup_consistency  = s.w_mlb_batter_lineup_consistency,
--     w_mlb_batter_weather_temp        = s.w_mlb_batter_weather_temp,
--     w_mlb_wind_direction_hr          = s.w_mlb_wind_direction_hr,
--     w_mlb_batter_pitcher_quality     = s.w_mlb_batter_pitcher_quality,
--     w_mlb_batter_form_power          = s.w_mlb_batter_form_power,
--     w_mlb_batter_recent_ab           = s.w_mlb_batter_recent_ab,
--     w_mlb_batter_babip               = s.w_mlb_batter_babip
--   FROM public.algorithm_weights_d520apply_snapshot s
--   WHERE w.id = 1 AND s.id = 1;
--   ALTER TABLE public.algorithm_weights DROP COLUMN w_mlb_batter_line_hit_rate;

DO $$
DECLARE
  v_handedness         numeric;
  v_weather_wind       numeric;
  v_lineup_consistency numeric;
  v_weather_temp       numeric;
  v_wind_direction_hr  numeric;
  v_pitcher_quality    numeric;
  v_form_power         numeric;
  v_recent_ab          numeric;
  v_babip              numeric;
BEGIN
  -- Read current values
  SELECT
    w_mlb_batter_handedness_matchup,
    w_mlb_batter_weather_wind,
    w_mlb_batter_lineup_consistency,
    w_mlb_batter_weather_temp,
    w_mlb_wind_direction_hr,
    w_mlb_batter_pitcher_quality,
    w_mlb_batter_form_power,
    w_mlb_batter_recent_ab,
    w_mlb_batter_babip
  INTO
    v_handedness, v_weather_wind, v_lineup_consistency, v_weather_temp,
    v_wind_direction_hr, v_pitcher_quality, v_form_power, v_recent_ab, v_babip
  FROM public.algorithm_weights WHERE id = 1;

  -- STOP-IF: any flagged weight deviates from D-520 validation magnitudes.
  -- If this fires, the apply does not match what was validated.
  IF v_handedness         <> 0.75  THEN RAISE EXCEPTION 'STOP-IF: handedness=% but D-520 validated 0.75', v_handedness; END IF;
  IF v_weather_wind       <> 0.5   THEN RAISE EXCEPTION 'STOP-IF: weather_wind=% but D-520 validated 0.5', v_weather_wind; END IF;
  IF v_lineup_consistency <> 0.5   THEN RAISE EXCEPTION 'STOP-IF: lineup_consistency=% but D-520 validated 0.5', v_lineup_consistency; END IF;
  IF v_weather_temp       <> 1.25  THEN RAISE EXCEPTION 'STOP-IF: weather_temp=% but D-520 validated 1.25', v_weather_temp; END IF;
  IF v_wind_direction_hr  <> 0.25  THEN RAISE EXCEPTION 'STOP-IF: wind_direction_hr=% but D-520 validated 0.25', v_wind_direction_hr; END IF;
  IF v_pitcher_quality    <> 1.5   THEN RAISE EXCEPTION 'STOP-IF: pitcher_quality=% but D-520 validated 1.5', v_pitcher_quality; END IF;
  IF v_form_power         <> 0.5   THEN RAISE EXCEPTION 'STOP-IF: form_power=% but D-520 validated 0.5', v_form_power; END IF;
  IF v_recent_ab          <> 1.0   THEN RAISE EXCEPTION 'STOP-IF: recent_ab=% but D-520 validated 1.0', v_recent_ab; END IF;
  IF v_babip              <> 0.125 THEN RAISE EXCEPTION 'STOP-IF: babip=% but D-520 validated 0.125', v_babip; END IF;

  RAISE NOTICE '[D-520-APPLY] STOP-IF check PASS — all 9 weights match D-520 validation magnitudes';

  -- Apply the 9 sign flips. Each new value = -old value, NOT a new value
  -- pulled from air.
  UPDATE public.algorithm_weights SET
    w_mlb_batter_handedness_matchup  = -v_handedness,
    w_mlb_batter_weather_wind        = -v_weather_wind,
    w_mlb_batter_lineup_consistency  = -v_lineup_consistency,
    w_mlb_batter_weather_temp        = -v_weather_temp,
    w_mlb_wind_direction_hr          = -v_wind_direction_hr,
    w_mlb_batter_pitcher_quality     = -v_pitcher_quality,
    w_mlb_batter_form_power          = -v_form_power,
    w_mlb_batter_recent_ab           = -v_recent_ab,
    w_mlb_batter_babip               = -v_babip,
    updated_at                       = now()
  WHERE id = 1;

  RAISE NOTICE '[D-520-APPLY] 9 sign flips committed (current -> negated):';
  RAISE NOTICE '  handedness        % -> %', v_handedness,         -v_handedness;
  RAISE NOTICE '  weather_wind      % -> %', v_weather_wind,       -v_weather_wind;
  RAISE NOTICE '  lineup_consistency % -> %', v_lineup_consistency, -v_lineup_consistency;
  RAISE NOTICE '  weather_temp      % -> %', v_weather_temp,       -v_weather_temp;
  RAISE NOTICE '  wind_direction_hr % -> %', v_wind_direction_hr,  -v_wind_direction_hr;
  RAISE NOTICE '  pitcher_quality   % -> %', v_pitcher_quality,    -v_pitcher_quality;
  RAISE NOTICE '  form_power        % -> %', v_form_power,         -v_form_power;
  RAISE NOTICE '  recent_ab         % -> %', v_recent_ab,          -v_recent_ab;
  RAISE NOTICE '  babip             % -> %', v_babip,              -v_babip;
END $$;

-- The 1 new factor weight column.
-- ADD COLUMN ... DEFAULT 2.0 populates existing row 1 with 2.0 in PG >= 11
-- (no table rewrite for constant default).
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_line_hit_rate NUMERIC NOT NULL DEFAULT 2.0;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-520-APPLY] post-apply readback (the 9 flips + new factor):';
  FOR r IN
    SELECT
      w_mlb_batter_handedness_matchup     AS handedness,
      w_mlb_batter_weather_wind           AS weather_wind,
      w_mlb_batter_lineup_consistency     AS lineup_consistency,
      w_mlb_batter_weather_temp           AS weather_temp,
      w_mlb_wind_direction_hr             AS wind_direction_hr,
      w_mlb_batter_pitcher_quality        AS pitcher_quality,
      w_mlb_batter_form_power             AS form_power,
      w_mlb_batter_recent_ab              AS recent_ab,
      w_mlb_batter_babip                  AS babip,
      w_mlb_batter_line_hit_rate          AS line_hit_rate
    FROM public.algorithm_weights WHERE id = 1
  LOOP
    RAISE NOTICE '  handedness=% weather_wind=% lineup_consistency=% weather_temp=% wind_direction_hr=% pitcher_quality=% form_power=% recent_ab=% babip=% line_hit_rate=%',
      r.handedness, r.weather_wind, r.lineup_consistency, r.weather_temp,
      r.wind_direction_hr, r.pitcher_quality, r.form_power, r.recent_ab, r.babip,
      r.line_hit_rate;
  END LOOP;
END $$;
