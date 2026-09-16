-- Morning verification bundle (May 11, 2026, 17:09 UTC).
-- All 6 §1.12 cycle-close checks from yesterday's deferred work.
-- Read-only NOTICE output.

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  RAISE NOTICE '=== Morning verification bundle @ % ===', v_now;

  -- ============================================================
  -- CHECK 1: C40 RPC writer fix — player-prop rows landing today?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 1 — C40 writer cycle (post commit c82de30) ###';
  FOR v_row IN
    SELECT
      DATE(created_at) AS day,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers')) AS player_props,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('spread','game_total')) AS game_props,
      COUNT(*) AS total
    FROM pick_history
    WHERE created_at >= v_now - INTERVAL '2 hours'
    GROUP BY DATE(created_at)
    ORDER BY day DESC
  LOOP
    RAISE NOTICE '  % : player_props=% game_props=% total=%',
      v_row.day, v_row.player_props, v_row.game_props, v_row.total;
  END LOOP;

  -- ============================================================
  -- CHECK 2: return_date scaling — new magnitudes appearing?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 2 — return_date scaling (post commits 4a71057+7a3fa87) ###';
  FOR v_row IN
    SELECT score_player_injury AS spi, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= v_now - INTERVAL '2 hours'
      AND ABS(COALESCE(score_player_injury, 0)) > 0.01
    GROUP BY score_player_injury
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  score_player_injury=%  rows=%', v_row.spi, v_row.n;
  END LOOP;
  SELECT COUNT(*) INTO v_count
  FROM pick_history
  WHERE created_at >= v_now - INTERVAL '2 hours'
    AND ABS(COALESCE(score_player_injury, 0)) > 0.01;
  RAISE NOTICE '  total non-zero injury-penalty rows in last 2h: %', v_count;

  -- ============================================================
  -- CHECK 3: May 7-9 backfill settlement after 5:30 UTC nightly
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 3 — May 7-9 backfill settlement ###';
  FOR v_row IN
    SELECT
      DATE(game_date) AS game_day,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      COUNT(*) FILTER (WHERE hit IS NULL) AS unresolved,
      COUNT(*) FILTER (WHERE voided = true) AS voided
    FROM pick_history
    WHERE source = 'backfill-may7-9-organic'
    GROUP BY DATE(game_date)
    ORDER BY game_day
  LOOP
    RAISE NOTICE '  game_day=% total=% resolved=% unresolved=% voided=%',
      v_row.game_day, v_row.total, v_row.resolved, v_row.unresolved, v_row.voided;
  END LOOP;

  -- ============================================================
  -- CHECK 4: Sunday May 10 6am ET = 11:00 UTC run-optimizer-v2 fire
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 4 — Sunday May 10 run-optimizer-v2 cron ###';
  FOR v_row IN
    SELECT created_at, severity, title, LEFT(COALESCE(message, ''), 200) AS msg
    FROM notifications_log
    WHERE created_at >= '2026-05-10'
      AND title ILIKE '%optim%'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  [%] sev=% — % | %',
      v_row.created_at, v_row.severity, v_row.title, v_row.msg;
  END LOOP;
  -- Also scan run_log for any run-optimizer-v2 entry (some functions may not write notifications_log on every path)
  RAISE NOTICE '  -- run_log entries for optimizer in last 36h:';
  FOR v_row IN
    SELECT created_at, function_name, status, LEFT(COALESCE(notes, ''), 100) AS notes_preview
    FROM run_log
    WHERE created_at >= v_now - INTERVAL '36 hours'
      AND (function_name ILIKE '%optim%' OR notes ILIKE '%optim%' OR notes ILIKE '%walk-forward%')
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '    [%] fn=% status=% notes=%',
      v_row.created_at, v_row.function_name, v_row.status, v_row.notes_preview;
  END LOOP;

  -- ============================================================
  -- CHECK 5: Sentry / error_log scan — overnight errors
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 5 — error_log overnight (May 10 00:00 UTC onward) ###';
  SELECT COUNT(*) INTO v_count
  FROM error_log
  WHERE created_at >= '2026-05-10 00:00:00';
  RAISE NOTICE '  total error_log entries since May 10 00:00 UTC: %', v_count;
  RAISE NOTICE '  -- top 10 most-recent:';
  FOR v_row IN
    SELECT created_at, function_name, COALESCE(error_type, '(none)') AS error_type,
           LEFT(COALESCE(error_message, ''), 160) AS msg,
           COALESCE(context->>'severity', '(unset)') AS severity
    FROM error_log
    WHERE created_at >= '2026-05-10 00:00:00'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '    [%] sev=% % :: % | %',
      v_row.created_at, v_row.severity, v_row.function_name, v_row.error_type, v_row.msg;
  END LOOP;

  -- ============================================================
  -- CHECK 6: framework v2.31 re-upload — can't check programmatically,
  -- just note for CEO + flag framework version markers in code/comments
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 6 — framework v2.31 re-upload status ###';
  RAISE NOTICE '  This check is CEO-action-only (re-upload to claude.ai project knowledge per §12.4).';
  RAISE NOTICE '  No DB-side signal exists; flagging for CEO confirmation.';

  -- ============================================================
  -- Cron job state for context (jobid 9 process-games + 12 optimizer)
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '### Cron job state (for context) ###';
  FOR v_row IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job
    WHERE jobid IN (1, 2, 3, 9, 10, 11, 12)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid=% name=% schedule=% active=%',
      v_row.jobid, v_row.jobname, v_row.schedule, v_row.active;
  END LOOP;

  -- Cron progress for today's slate
  RAISE NOTICE '';
  RAISE NOTICE '### Today cron_progress ###';
  FOR v_row IN
    SELECT id, away_team, home_team, status, completed_at, props_scored, picks_recommended
    FROM cron_progress
    WHERE game_date = TO_CHAR((NOW() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD')
    ORDER BY game_time
  LOOP
    RAISE NOTICE '  id=% % vs % :: status=% completed=% props=% picks=%',
      v_row.id, v_row.away_team, v_row.home_team, v_row.status,
      v_row.completed_at, v_row.props_scored, v_row.picks_recommended;
  END LOOP;
END $$;
