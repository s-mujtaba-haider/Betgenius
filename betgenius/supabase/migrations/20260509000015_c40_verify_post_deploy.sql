-- C40 fix verification @ 18:38 UTC May 9. Deploy at 18:26:49 UTC, expected
-- 18:30 cron tick to write player-prop rows. Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_today DATE := CURRENT_DATE;
  v_count INTEGER;
  v_player_today INTEGER;
  v_post_deploy_errors INTEGER;
BEGIN
  RAISE NOTICE '=== C40 verify post-deploy @ % ===', NOW();

  -- 1. Per-day breakdown for last 4 days
  RAISE NOTICE '';
  RAISE NOTICE '--- pick_history per-day breakdown last 4 days ---';
  FOR v_row IN
    SELECT
      game_date,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers')) AS player_props,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('spread','game_total')) AS game_props,
      COUNT(*) FILTER (WHERE is_synthetic = false) AS production_total,
      COUNT(*) AS total
    FROM pick_history
    WHERE game_date >= v_today - 4
    GROUP BY game_date
    ORDER BY game_date DESC
  LOOP
    RAISE NOTICE '  %: player_props=% game_props=% prod_total=% all=%',
      v_row.game_date, v_row.player_props, v_row.game_props, v_row.production_total, v_row.total;
  END LOOP;

  -- 2. Today's player-prop rows in detail
  SELECT COUNT(*) INTO v_player_today
  FROM pick_history
  WHERE game_date = v_today
    AND is_synthetic = false
    AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers');
  RAISE NOTICE '';
  RAISE NOTICE '--- TODAY player-prop pick_history rows: % ---', v_player_today;

  RAISE NOTICE '  most-recent 5 rows:';
  FOR v_row IN
    SELECT created_at, player_name, prop_type, pick_side, line, confidence, source
    FROM pick_history
    WHERE game_date = v_today
      AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total')
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '    [%] % %/% line=% conf=% source=%',
      v_row.created_at, v_row.player_name, v_row.prop_type, v_row.pick_side,
      v_row.line, v_row.confidence, v_row.source;
  END LOOP;

  -- 3. error_log — any new entries from process-games since C40 deploy?
  SELECT COUNT(*) INTO v_post_deploy_errors
  FROM error_log
  WHERE function_name = 'process-games'
    AND created_at > '2026-05-09 18:26:49+00';
  RAISE NOTICE '';
  RAISE NOTICE '--- error_log: process-games errors since C40 deploy (18:26:49 UTC) ---';
  RAISE NOTICE '  total: %  (expected 0 from C40 fix; pre-existing types acceptable)', v_post_deploy_errors;

  IF v_post_deploy_errors > 0 THEN
    FOR v_row IN
      SELECT created_at, phase, error_type, LEFT(error_message, 200) AS msg
      FROM error_log
      WHERE function_name = 'process-games'
        AND created_at > '2026-05-09 18:26:49+00'
      ORDER BY created_at DESC
    LOOP
      RAISE NOTICE '  [%] %::%  | %',
        v_row.created_at, v_row.phase, v_row.error_type, v_row.msg;
    END LOOP;
  END IF;

  -- 4. Specifically: rpc_upsert_failed or rpc_upsert_threw (new error types from C40 fix)
  SELECT COUNT(*) INTO v_count
  FROM error_log
  WHERE function_name = 'process-games'
    AND error_type IN ('rpc_upsert_failed', 'rpc_upsert_threw')
    AND created_at > '2026-05-09 18:26:49+00';
  RAISE NOTICE '';
  RAISE NOTICE 'rpc_upsert_failed/threw entries since deploy: %  (expected 0)', v_count;

  -- 5. cron_progress for today
  RAISE NOTICE '';
  RAISE NOTICE '--- cron_progress today ---';
  FOR v_row IN
    SELECT id, away_team, home_team, status, completed_at, props_scored, picks_recommended
    FROM cron_progress
    WHERE game_date = TO_CHAR(v_today, 'YYYYMMDD')
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
      AND created_at > '2026-05-09 18:26:49+00'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min  status=%  games=%  recs=%',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations;
  END LOOP;
END $$;
