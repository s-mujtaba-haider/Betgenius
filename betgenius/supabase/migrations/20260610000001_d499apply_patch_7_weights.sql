-- D-499-APPLY (2026-06-10) — Apply 7 CEO-approved MLB weight moves to
-- algorithm_weights row 1. §19.3 explicit approval given via D-499 §5
-- sign-off block in docs/loop/reports/d499_chained_final.md.
--
-- WHAT THIS DOES:
--   UPDATEs exactly 7 columns on algorithm_weights WHERE id=1. The
--   other 77 columns (incl. all 8 D-498-added factors) are NOT in the
--   SET clause and remain byte-identical to the pre-apply snapshot.
--
-- ROLLBACK:
--   Pre-apply snapshot of the full 84-column row is at:
--     docs/loop/reports/d499apply_snapshot.json
--   To restore:
--     UPDATE public.algorithm_weights SET
--       w_mlb_pitcher_ballpark_factor       = 1.0,
--       w_mlb_batter_form_power             = 0.75,
--       w_mlb_game_h2h_recent               = 0.5,
--       w_mlb_game_team_form                = 1.75,
--       w_mlb_batter_vs_pitcher_hand_split  = 1.25,
--       w_mlb_wind_direction_hr             = 0.5,
--       w_mlb_pitcher_hr_per_9              = 1.5,
--       updated_at                          = NOW()
--     WHERE id = 1;
--
-- INVARIANT GUARDS (in this migration):
--   1. Pre-write: snapshot 7 current values + assert each matches the
--      pre-apply expected value (the values that were proposed against).
--      If a current value drifted, ABORT — the proposal targeted the
--      drifted-from baseline.
--   2. Write: UPDATE with only the 7 SET clauses + updated_at.
--   3. Post-write: re-read 7, assert each == proposed; also re-read the
--      8 D-498-added cols, assert each unchanged at seed values.
--      RAISE EXCEPTION on any mismatch (transaction rolls back).

DO $$
DECLARE
  r RECORD;
  -- Pre-apply expected values (from D-499 SHIP 1 snapshot + §5 PATCH block)
  v_expected_pre_ballpark NUMERIC := 1.0;
  v_expected_pre_form_power NUMERIC := 0.75;
  v_expected_pre_h2h NUMERIC := 0.5;
  v_expected_pre_team_form NUMERIC := 1.75;
  v_expected_pre_vs_hand_split NUMERIC := 1.25;
  v_expected_pre_wind_hr NUMERIC := 0.5;
  v_expected_pre_hr_per_9 NUMERIC := 1.5;
  -- Proposed values (from §5 sign-off block)
  v_new_ballpark NUMERIC := 1.5;
  v_new_form_power NUMERIC := 0.5;
  v_new_h2h NUMERIC := 0.25;
  v_new_team_form NUMERIC := 2.5;
  v_new_vs_hand_split NUMERIC := 1.5;
  v_new_wind_hr NUMERIC := 0.25;
  v_new_hr_per_9 NUMERIC := 0.75;
  -- 8 D-498 seed values (must NOT change)
  v_seed_lineup_spot NUMERIC := 1.0;
  v_seed_day_after_night NUMERIC := 0.5;
  v_seed_travel NUMERIC := 0.5;
  v_seed_command_trend NUMERIC := 0.5;
  v_seed_velocity_trend NUMERIC := 1.0;
  v_seed_baa_vs_hand NUMERIC := 1.0;
  v_seed_lineup_k NUMERIC := 1.0;
  v_seed_streak_fatigue NUMERIC := 0.5;
BEGIN
  -- ============ PRE-WRITE: assert current values match expected ============
  SELECT
    w_mlb_pitcher_ballpark_factor,
    w_mlb_batter_form_power,
    w_mlb_game_h2h_recent,
    w_mlb_game_team_form,
    w_mlb_batter_vs_pitcher_hand_split,
    w_mlb_wind_direction_hr,
    w_mlb_pitcher_hr_per_9
  INTO r
  FROM public.algorithm_weights WHERE id = 1;

  IF r.w_mlb_pitcher_ballpark_factor      <> v_expected_pre_ballpark      THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_pitcher_ballpark_factor: actual=% expected=%', r.w_mlb_pitcher_ballpark_factor, v_expected_pre_ballpark; END IF;
  IF r.w_mlb_batter_form_power            <> v_expected_pre_form_power    THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_batter_form_power: actual=% expected=%', r.w_mlb_batter_form_power, v_expected_pre_form_power; END IF;
  IF r.w_mlb_game_h2h_recent              <> v_expected_pre_h2h           THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_game_h2h_recent: actual=% expected=%', r.w_mlb_game_h2h_recent, v_expected_pre_h2h; END IF;
  IF r.w_mlb_game_team_form               <> v_expected_pre_team_form     THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_game_team_form: actual=% expected=%', r.w_mlb_game_team_form, v_expected_pre_team_form; END IF;
  IF r.w_mlb_batter_vs_pitcher_hand_split <> v_expected_pre_vs_hand_split THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_batter_vs_pitcher_hand_split: actual=% expected=%', r.w_mlb_batter_vs_pitcher_hand_split, v_expected_pre_vs_hand_split; END IF;
  IF r.w_mlb_wind_direction_hr            <> v_expected_pre_wind_hr       THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_wind_direction_hr: actual=% expected=%', r.w_mlb_wind_direction_hr, v_expected_pre_wind_hr; END IF;
  IF r.w_mlb_pitcher_hr_per_9             <> v_expected_pre_hr_per_9      THEN RAISE EXCEPTION '[D-499-APPLY] PRE drift on w_mlb_pitcher_hr_per_9: actual=% expected=%', r.w_mlb_pitcher_hr_per_9, v_expected_pre_hr_per_9; END IF;
  RAISE NOTICE '[D-499-APPLY] PRE check passed — 7 current values match proposal baseline';

  -- ============ APPLY: UPDATE 7 columns + updated_at ============
  UPDATE public.algorithm_weights SET
    w_mlb_pitcher_ballpark_factor      = v_new_ballpark,
    w_mlb_batter_form_power            = v_new_form_power,
    w_mlb_game_h2h_recent              = v_new_h2h,
    w_mlb_game_team_form               = v_new_team_form,
    w_mlb_batter_vs_pitcher_hand_split = v_new_vs_hand_split,
    w_mlb_wind_direction_hr            = v_new_wind_hr,
    w_mlb_pitcher_hr_per_9             = v_new_hr_per_9,
    updated_at                         = NOW()
  WHERE id = 1;
  RAISE NOTICE '[D-499-APPLY] UPDATE issued — 7 cols changed + updated_at';

  -- ============ POST-WRITE: re-read 7 and assert == proposed ============
  SELECT
    w_mlb_pitcher_ballpark_factor,
    w_mlb_batter_form_power,
    w_mlb_game_h2h_recent,
    w_mlb_game_team_form,
    w_mlb_batter_vs_pitcher_hand_split,
    w_mlb_wind_direction_hr,
    w_mlb_pitcher_hr_per_9
  INTO r
  FROM public.algorithm_weights WHERE id = 1;

  IF r.w_mlb_pitcher_ballpark_factor      <> v_new_ballpark      THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_pitcher_ballpark_factor: actual=% expected=%', r.w_mlb_pitcher_ballpark_factor, v_new_ballpark; END IF;
  IF r.w_mlb_batter_form_power            <> v_new_form_power    THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_batter_form_power: actual=% expected=%', r.w_mlb_batter_form_power, v_new_form_power; END IF;
  IF r.w_mlb_game_h2h_recent              <> v_new_h2h           THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_game_h2h_recent: actual=% expected=%', r.w_mlb_game_h2h_recent, v_new_h2h; END IF;
  IF r.w_mlb_game_team_form               <> v_new_team_form     THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_game_team_form: actual=% expected=%', r.w_mlb_game_team_form, v_new_team_form; END IF;
  IF r.w_mlb_batter_vs_pitcher_hand_split <> v_new_vs_hand_split THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_batter_vs_pitcher_hand_split: actual=% expected=%', r.w_mlb_batter_vs_pitcher_hand_split, v_new_vs_hand_split; END IF;
  IF r.w_mlb_wind_direction_hr            <> v_new_wind_hr       THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_wind_direction_hr: actual=% expected=%', r.w_mlb_wind_direction_hr, v_new_wind_hr; END IF;
  IF r.w_mlb_pitcher_hr_per_9             <> v_new_hr_per_9      THEN RAISE EXCEPTION '[D-499-APPLY] POST mismatch on w_mlb_pitcher_hr_per_9: actual=% expected=%', r.w_mlb_pitcher_hr_per_9, v_new_hr_per_9; END IF;
  RAISE NOTICE '[D-499-APPLY] POST check 1 passed — 7 cols now at proposed values';

  -- ============ POST-WRITE: assert 8 D-498-added cols unchanged at seed ============
  SELECT
    w_mlb_lineup_spot,
    w_mlb_day_after_night_fatigue,
    w_mlb_travel_getaway,
    w_mlb_pitcher_command_trend,
    w_mlb_pitcher_velocity_trend,
    w_mlb_pitcher_baa_vs_hand,
    w_mlb_lineup_k_composition,
    w_mlb_hitter_streak_fatigue
  INTO r
  FROM public.algorithm_weights WHERE id = 1;

  IF r.w_mlb_lineup_spot              <> v_seed_lineup_spot      THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_lineup_spot: actual=% seed=%', r.w_mlb_lineup_spot, v_seed_lineup_spot; END IF;
  IF r.w_mlb_day_after_night_fatigue  <> v_seed_day_after_night  THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_day_after_night_fatigue: actual=% seed=%', r.w_mlb_day_after_night_fatigue, v_seed_day_after_night; END IF;
  IF r.w_mlb_travel_getaway           <> v_seed_travel           THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_travel_getaway: actual=% seed=%', r.w_mlb_travel_getaway, v_seed_travel; END IF;
  IF r.w_mlb_pitcher_command_trend    <> v_seed_command_trend    THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_pitcher_command_trend: actual=% seed=%', r.w_mlb_pitcher_command_trend, v_seed_command_trend; END IF;
  IF r.w_mlb_pitcher_velocity_trend   <> v_seed_velocity_trend   THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_pitcher_velocity_trend: actual=% seed=%', r.w_mlb_pitcher_velocity_trend, v_seed_velocity_trend; END IF;
  IF r.w_mlb_pitcher_baa_vs_hand      <> v_seed_baa_vs_hand      THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_pitcher_baa_vs_hand: actual=% seed=%', r.w_mlb_pitcher_baa_vs_hand, v_seed_baa_vs_hand; END IF;
  IF r.w_mlb_lineup_k_composition     <> v_seed_lineup_k         THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_lineup_k_composition: actual=% seed=%', r.w_mlb_lineup_k_composition, v_seed_lineup_k; END IF;
  IF r.w_mlb_hitter_streak_fatigue    <> v_seed_streak_fatigue   THEN RAISE EXCEPTION '[D-499-APPLY] 8-factor drift on w_mlb_hitter_streak_fatigue: actual=% seed=%', r.w_mlb_hitter_streak_fatigue, v_seed_streak_fatigue; END IF;
  RAISE NOTICE '[D-499-APPLY] POST check 2 passed — 8 D-498-added cols still at seed values';

  RAISE NOTICE '[D-499-APPLY] SUCCESS — 7 weights applied, 8 D-498 frozen, transaction will commit';
END $$;
