-- D-747-DEPLOY STEP 2 RESTORE + STEP 3 TEST B.
-- Restore D-746 weights from algorithm_weights_d747_pre_test (the real D-746 state).
-- Then apply Test B (current ×1.5) and re-rescore.

-- RESTORE all 16 pitcher_k-relevant weights to their D-746 values
UPDATE algorithm_weights SET
  w_mlb_pitcher_k_rate         = (SELECT w_mlb_pitcher_k_rate         FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_form           = (SELECT w_mlb_pitcher_form           FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_opposing_lineup_k      = (SELECT w_mlb_opposing_lineup_k      FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_handedness_matchup     = (SELECT w_mlb_handedness_matchup     FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitch_count_trend      = (SELECT w_mlb_pitch_count_trend      FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_rest_pitcher           = (SELECT w_mlb_rest_pitcher           FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_ballpark_factor = (SELECT w_mlb_pitcher_ballpark_factor FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_weather_wind   = (SELECT w_mlb_pitcher_weather_wind   FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_weather_temp   = (SELECT w_mlb_pitcher_weather_temp   FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_umpire_k_zone  = (SELECT w_mlb_pitcher_umpire_k_zone  FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_command_trend  = (SELECT w_mlb_pitcher_command_trend  FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_velocity_trend = (SELECT w_mlb_pitcher_velocity_trend FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_xera_edge      = (SELECT w_mlb_pitcher_xera_edge      FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_baa            = (SELECT w_mlb_pitcher_baa            FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_catcher_framing        = (SELECT w_mlb_catcher_framing        FROM algorithm_weights_d747_pre_test LIMIT 1),
  w_mlb_pitcher_pitch_mix_k    = (SELECT w_mlb_pitcher_pitch_mix_k    FROM algorithm_weights_d747_pre_test LIMIT 1),
  updated_at = now()
WHERE id = 1;

-- Verify restore via NOTICE (manually inspected after push)
DO $$
DECLARE
  pre_state record;
  cur_state record;
  mismatch_count INT := 0;
BEGIN
  SELECT * INTO pre_state FROM algorithm_weights_d747_pre_test LIMIT 1;
  SELECT * INTO cur_state FROM algorithm_weights WHERE id = 1;
  IF pre_state.w_mlb_pitcher_k_rate         <> cur_state.w_mlb_pitcher_k_rate         THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_form           <> cur_state.w_mlb_pitcher_form           THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_opposing_lineup_k      <> cur_state.w_mlb_opposing_lineup_k      THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_handedness_matchup     <> cur_state.w_mlb_handedness_matchup     THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitch_count_trend      <> cur_state.w_mlb_pitch_count_trend      THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_rest_pitcher           <> cur_state.w_mlb_rest_pitcher           THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_ballpark_factor<> cur_state.w_mlb_pitcher_ballpark_factor THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_weather_wind   <> cur_state.w_mlb_pitcher_weather_wind   THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_weather_temp   <> cur_state.w_mlb_pitcher_weather_temp   THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_umpire_k_zone  <> cur_state.w_mlb_pitcher_umpire_k_zone  THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_command_trend  <> cur_state.w_mlb_pitcher_command_trend  THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_velocity_trend <> cur_state.w_mlb_pitcher_velocity_trend THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_xera_edge      <> cur_state.w_mlb_pitcher_xera_edge      THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_baa            <> cur_state.w_mlb_pitcher_baa            THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_catcher_framing        <> cur_state.w_mlb_catcher_framing        THEN mismatch_count := mismatch_count + 1; END IF;
  IF pre_state.w_mlb_pitcher_pitch_mix_k    <> cur_state.w_mlb_pitcher_pitch_mix_k    THEN mismatch_count := mismatch_count + 1; END IF;
  RAISE NOTICE 'D-747 post-A restore: mismatch_count=% (expected 0)', mismatch_count;
END $$;

-- Now apply Test B = current ×1.5 on every pitcher_k-relevant weight
-- (current here = D-746 baseline since we just restored)
UPDATE algorithm_weights SET
  w_mlb_pitcher_k_rate         = w_mlb_pitcher_k_rate         * 1.5,
  w_mlb_pitcher_form           = w_mlb_pitcher_form           * 1.5,
  w_mlb_opposing_lineup_k      = w_mlb_opposing_lineup_k      * 1.5,
  w_mlb_handedness_matchup     = w_mlb_handedness_matchup     * 1.5,
  w_mlb_pitch_count_trend      = w_mlb_pitch_count_trend      * 1.5,
  w_mlb_rest_pitcher           = w_mlb_rest_pitcher           * 1.5,
  w_mlb_pitcher_ballpark_factor = w_mlb_pitcher_ballpark_factor * 1.5,
  w_mlb_pitcher_weather_wind   = w_mlb_pitcher_weather_wind   * 1.5,
  w_mlb_pitcher_weather_temp   = w_mlb_pitcher_weather_temp   * 1.5,
  w_mlb_pitcher_umpire_k_zone  = w_mlb_pitcher_umpire_k_zone  * 1.5,
  w_mlb_pitcher_command_trend  = w_mlb_pitcher_command_trend  * 1.5,
  w_mlb_pitcher_velocity_trend = w_mlb_pitcher_velocity_trend * 1.5,
  w_mlb_pitcher_xera_edge      = w_mlb_pitcher_xera_edge      * 1.5,
  w_mlb_pitcher_baa            = w_mlb_pitcher_baa            * 1.5,
  w_mlb_catcher_framing        = w_mlb_catcher_framing        * 1.5,
  w_mlb_pitcher_pitch_mix_k    = w_mlb_pitcher_pitch_mix_k    * 1.5,
  updated_at = now()
WHERE id = 1;

-- Clear validate window + trigger Test B rescore
DELETE FROM pitcher_k_rescore_results
WHERE game_date >= '2026-06-10' AND game_date < '2026-06-24';

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-10','end_date','2026-06-15','limit',300,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-16','end_date','2026-06-23','limit',400,'dry_run',false),
  timeout_milliseconds := 150000
);
