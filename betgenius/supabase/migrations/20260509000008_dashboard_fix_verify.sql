-- Dashboard fix verification @ 16:48 UTC May 9. Read-only.
-- Deploy was at 16:33:42 UTC; first post-deploy cron tick at 16:45 UTC.

DO $$
DECLARE
  v_row RECORD;
  v_today_text TEXT;
  v_today_date DATE;
  v_count INTEGER;
  v_post_deploy_errors INTEGER;
BEGIN
  v_today_text := TO_CHAR((NOW() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_today_date := (NOW() AT TIME ZONE 'America/New_York')::date;
  RAISE NOTICE '=== Dashboard fix verification @ % ===', NOW();

  -- 1. recommendations_cache today
  SELECT COUNT(*) INTO v_count
  FROM recommendations_cache
  WHERE game_date = v_today_date;
  RAISE NOTICE '';
  RAISE NOTICE '--- recommendations_cache rows for today (%) ---', v_today_date;
  RAISE NOTICE '  total: %', v_count;

  RAISE NOTICE '  by prop_type:';
  FOR v_row IN
    SELECT prop_type, COUNT(*) AS n
    FROM recommendations_cache
    WHERE game_date = v_today_date
    GROUP BY prop_type
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '    %: %', v_row.prop_type, v_row.n;
  END LOOP;

  RAISE NOTICE '  most-recent 3 rows:';
  FOR v_row IN
    SELECT created_at, sport, player_name, prop_type, line, pick_side, confidence
    FROM recommendations_cache
    WHERE game_date = v_today_date
    ORDER BY created_at DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '    [%] % % %/% line=% conf=%',
      v_row.created_at, v_row.sport, v_row.player_name, v_row.prop_type, v_row.pick_side, v_row.line, v_row.confidence;
  END LOOP;

  -- 2. pick_history today
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE created_at >= DATE_TRUNC('day', NOW());
  RAISE NOTICE '';
  RAISE NOTICE 'pick_history rows created today (UTC): %', v_count;

  -- 3. error_log — any cache_write_failed since deploy at 16:33:42 UTC?
  SELECT COUNT(*) INTO v_post_deploy_errors
  FROM error_log
  WHERE function_name = 'process-games'
    AND error_type = 'cache_write_failed'
    AND created_at > '2026-05-09 16:33:42+00';
  RAISE NOTICE '';
  RAISE NOTICE '--- error_log: cache_write_failed entries since deploy (16:33:42 UTC) ---';
  RAISE NOTICE '  count: %  (expected: 0)', v_post_deploy_errors;
  IF v_post_deploy_errors > 0 THEN
    FOR v_row IN
      SELECT created_at, phase, LEFT(error_message, 240) AS msg
      FROM error_log
      WHERE function_name = 'process-games'
        AND error_type = 'cache_write_failed'
        AND created_at > '2026-05-09 16:33:42+00'
      ORDER BY created_at DESC
    LOOP
      RAISE NOTICE '  [%] phase=% msg=%', v_row.created_at, v_row.phase, v_row.msg;
    END LOOP;
  END IF;

  -- 4. ANY error_log entries from process-games in last 30 min (broader)
  RAISE NOTICE '';
  RAISE NOTICE '--- error_log: any process-games errors in last 30 min ---';
  FOR v_row IN
    SELECT created_at, phase, error_type, LEFT(error_message, 200) AS msg
    FROM error_log
    WHERE function_name = 'process-games'
      AND created_at >= NOW() - INTERVAL '30 minutes'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  [%] %::%  | %', v_row.created_at, v_row.phase, v_row.error_type, v_row.msg;
  END LOOP;

  -- 5. cron_progress for today — should be advancing now
  RAISE NOTICE '';
  RAISE NOTICE '--- cron_progress for today ---';
  FOR v_row IN
    SELECT id, away_team, home_team, status, started_at, completed_at,
           props_scored, picks_recommended
    FROM cron_progress
    WHERE game_date = v_today_text
    ORDER BY game_time
  LOOP
    RAISE NOTICE '  id=% % vs % :: status=% completed=% props=% picks=%',
      v_row.id, v_row.away_team, v_row.home_team, v_row.status,
      v_row.completed_at, v_row.props_scored, v_row.picks_recommended;
  END LOOP;

  -- 6. run_log post-deploy
  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: process-games rows since deploy ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at > '2026-05-09 16:33:42+00'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min  status=%  games=%  recs=%',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations;
  END LOOP;
END $$;
