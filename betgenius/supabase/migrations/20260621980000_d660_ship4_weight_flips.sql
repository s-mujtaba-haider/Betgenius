-- D-660 SHIP 4 — flip 4 backwards weights identified by signed-lift
-- partial fit on n=617 post-D-520 resolved batter HR/TB/RBI picks.
--
-- §19.3 CEO-APPROVED per D-660 spec ("fix backwards weights").
-- Per spec: "Don't blind-flip — show the lift." Lift documented inline.
--
-- Evidence (full table in d660_*.md; one row shown here per market):
--   score_batter_form_power      w=-0.5  HR lift +12.8pp / TB +5.9pp / RBI +5.5pp → WRONG SIGN
--   score_weather_temp           w=-1.25 HR lift +63.1pp / TB +17.9pp / RBI +29.4pp → VERY WRONG
--   score_opposing_pitcher_quality w=-1.5 HR lift +8.5pp / TB +4.9pp → WRONG SIGN
--   score_lineup_consistency     w=-0.5  HR lift +23.4pp / TB +9.5pp / RBI +26.3pp → WRONG SIGN
--
-- Rollback: single UPDATE statement at end of file's documentation block.
-- Snapshot saved as algorithm_weights_d660ship4_snapshot (pre-apply).
DO $$
DECLARE
  v_form_power      NUMERIC;
  v_weather_temp    NUMERIC;
  v_pitcher_quality NUMERIC;
  v_lineup_consist  NUMERIC;
BEGIN
  -- 1. Read prior values + sanity-check expected pre-apply state.
  SELECT
    w_mlb_batter_form_power,
    w_mlb_batter_weather_temp,
    w_mlb_batter_pitcher_quality,
    w_mlb_batter_lineup_consistency
  INTO
    v_form_power, v_weather_temp, v_pitcher_quality, v_lineup_consist
  FROM algorithm_weights WHERE id = 1;

  RAISE NOTICE 'D-660 SHIP 4 PRE — form_power=% weather_temp=% pitcher_quality=% lineup_consistency=%',
    v_form_power, v_weather_temp, v_pitcher_quality, v_lineup_consist;

  IF v_form_power      <> -0.5 THEN RAISE EXCEPTION 'D-660 drift: form_power expected -0.5, got %', v_form_power; END IF;
  IF v_weather_temp    <> -1.25 THEN RAISE EXCEPTION 'D-660 drift: weather_temp expected -1.25, got %', v_weather_temp; END IF;
  IF v_pitcher_quality <> -1.5 THEN RAISE EXCEPTION 'D-660 drift: pitcher_quality expected -1.5, got %', v_pitcher_quality; END IF;
  IF v_lineup_consist  <> -0.5 THEN RAISE EXCEPTION 'D-660 drift: lineup_consistency expected -0.5, got %', v_lineup_consist; END IF;

  -- 2. Save snapshot for rollback (only the 4 columns we're touching + meta cols).
  CREATE TABLE IF NOT EXISTS algorithm_weights_d660ship4_snapshot AS
    SELECT id, w_mlb_batter_form_power, w_mlb_batter_weather_temp,
           w_mlb_batter_pitcher_quality, w_mlb_batter_lineup_consistency,
           NOW() AS snapshot_at
    FROM algorithm_weights WHERE id = 1;

  -- 3. APPLY the 4 flips (× -1 each).
  UPDATE algorithm_weights
  SET w_mlb_batter_form_power        = -1 * v_form_power,      -- -0.5 → +0.5
      w_mlb_batter_weather_temp      = -1 * v_weather_temp,    -- -1.25 → +1.25
      w_mlb_batter_pitcher_quality   = -1 * v_pitcher_quality, -- -1.5 → +1.5
      w_mlb_batter_lineup_consistency = -1 * v_lineup_consist,  -- -0.5 → +0.5
      updated_at = NOW()
  WHERE id = 1;

  -- 4. POST-check.
  SELECT
    w_mlb_batter_form_power,
    w_mlb_batter_weather_temp,
    w_mlb_batter_pitcher_quality,
    w_mlb_batter_lineup_consistency
  INTO
    v_form_power, v_weather_temp, v_pitcher_quality, v_lineup_consist
  FROM algorithm_weights WHERE id = 1;

  IF v_form_power      <> 0.5  THEN RAISE EXCEPTION 'D-660 POST drift: form_power expected 0.5, got %', v_form_power; END IF;
  IF v_weather_temp    <> 1.25 THEN RAISE EXCEPTION 'D-660 POST drift: weather_temp expected 1.25, got %', v_weather_temp; END IF;
  IF v_pitcher_quality <> 1.5  THEN RAISE EXCEPTION 'D-660 POST drift: pitcher_quality expected 1.5, got %', v_pitcher_quality; END IF;
  IF v_lineup_consist  <> 0.5  THEN RAISE EXCEPTION 'D-660 POST drift: lineup_consistency expected 0.5, got %', v_lineup_consist; END IF;

  RAISE NOTICE 'D-660 SHIP 4 POST — form_power=% weather_temp=% pitcher_quality=% lineup_consistency=%',
    v_form_power, v_weather_temp, v_pitcher_quality, v_lineup_consist;
END $$;

-- ROLLBACK (single statement; un-comment to revert):
-- UPDATE algorithm_weights
-- SET w_mlb_batter_form_power = -0.5,
--     w_mlb_batter_weather_temp = -1.25,
--     w_mlb_batter_pitcher_quality = -1.5,
--     w_mlb_batter_lineup_consistency = -0.5,
--     updated_at = NOW()
-- WHERE id = 1;
