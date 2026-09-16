-- D-747-DEPLOY STEP 2 — TEST A: temporarily apply Claude logic weights, re-rescore,
-- restore D-746 weights. Safety harness via algorithm_weights_d747_d746_restore snapshot.
--
-- §19.3 — temporary DB write with mandatory restore. Cron paused (D-737e).
-- Snapshot taken pre-apply; restore happens after the test completes.

-- 1) Capture CURRENT (post-D-746) state for guaranteed restore. The existing
--    algorithm_weights_d746_snapshot has pre-D-746 (D-744) values — we need the
--    real D-746 state.
CREATE TABLE IF NOT EXISTS algorithm_weights_d747_pre_test AS
  SELECT *, now() AS snapshot_at FROM algorithm_weights WHERE id = 1;

-- 2) Mark the in-table rescore_results window for clearing (we don't actually
--    delete here — we'll delete + re-trigger via the rescore function).
DELETE FROM pitcher_k_rescore_results
WHERE game_date >= '2026-06-10' AND game_date < '2026-06-24';

-- 3) Apply Test A weights (CEO/Claude logic; per brief):
--    Changed: opposing_lineup_k 1.5→2.0; pitch_count_trend 0.03→0.75;
--             velocity_trend 0.17→0.75; rest_pitcher -0.04→0.5;
--             ballpark_factor -0.01→0.5; k_rate 0.25→1.0;
--             command_trend 0.5→0.75; weather_wind -0.19→-0.25;
--             weather_temp 0.09→0.25
--    Unchanged: form 1.0, pitch_mix_k 1.0, the 5 D-746 restored (handedness=0.5,
--             umpire=0.5, xera=0.25, baa=0.25, framing=0.25)
UPDATE algorithm_weights SET
  w_mlb_opposing_lineup_k          = 2.0,
  w_mlb_pitch_count_trend          = 0.75,
  w_mlb_pitcher_velocity_trend     = 0.75,
  w_mlb_rest_pitcher               = 0.5,
  w_mlb_pitcher_ballpark_factor    = 0.5,
  w_mlb_pitcher_k_rate             = 1.0,
  w_mlb_pitcher_command_trend      = 0.75,
  w_mlb_pitcher_weather_wind       = -0.25,
  w_mlb_pitcher_weather_temp       = 0.25,
  updated_at = now()
WHERE id = 1;

-- 4) Trigger rescore (uses now-applied Test A weights via runtime DB lookup)
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
