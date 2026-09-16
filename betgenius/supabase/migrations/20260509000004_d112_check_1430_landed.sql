-- D-112 — check if 14:30 UTC tick has landed in run_log yet (May 9, 2026).
-- Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_count_skipped_today INTEGER;
  v_count_success_today INTEGER;
  v_alerts_after_deploy INTEGER;
BEGIN
  RAISE NOTICE '=== D-112 1430 landing check @ % ===', NOW();

  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: process-games rows in last 10 min ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min,
           LEFT(COALESCE(notes, '(no notes)'), 200) AS notes_preview
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min  status=%  games=%  recs=%  notes: %',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations, v_row.notes_preview;
  END LOOP;

  SELECT COUNT(*) INTO v_count_success_today
  FROM run_log
  WHERE function_name = 'process-games' AND status = 'success'
    AND created_at >= DATE_TRUNC('day', NOW());
  SELECT COUNT(*) INTO v_count_skipped_today
  FROM run_log
  WHERE function_name = 'process-games' AND status = 'skipped'
    AND created_at >= DATE_TRUNC('day', NOW());

  RAISE NOTICE '';
  RAISE NOTICE 'Today (UTC): success=% skipped=%', v_count_success_today, v_count_skipped_today;

  SELECT COUNT(*) INTO v_alerts_after_deploy
  FROM notifications_log
  WHERE created_at >= '2026-05-09 14:12:00+00'
    AND title ILIKE '%cron silent%'
    AND severity = 'critical';
  RAISE NOTICE 'Critical "cron silent" alerts since deploy (14:12 UTC): %', v_alerts_after_deploy;

  -- Look for the 14:30 UTC health-monitor fire — it should have completed by now (every 30 min)
  RAISE NOTICE '';
  RAISE NOTICE '--- notifications_log: any rows in last 5 min (health-monitor fires every 30 min) ---';
  FOR v_row IN
    SELECT created_at, severity, title,
           LEFT(COALESCE(message, ''), 100) AS msg_preview
    FROM notifications_log
    WHERE created_at >= NOW() - INTERVAL '5 minutes'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  [%] sev=% — % | %',
      v_row.created_at, v_row.severity, v_row.title, v_row.msg_preview;
  END LOOP;
END $$;
