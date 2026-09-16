-- D-112 followup at 14:38 UTC. Looking for any 'skipped' row + cron_progress
-- state. Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_count_skipped_today INTEGER;
  v_count_success_today INTEGER;
  v_alerts_after_deploy INTEGER;
  v_pending INTEGER;
  v_complete INTEGER;
  v_processing INTEGER;
  v_today TEXT;
BEGIN
  v_today := TO_CHAR((NOW() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  RAISE NOTICE '=== D-112 followup @ % ===', NOW();

  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: process-games rows in last 30 min ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min,
           LEFT(COALESCE(notes, '(no notes)'), 240) AS notes_preview
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at >= NOW() - INTERVAL '30 minutes'
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

  -- cron_progress state
  SELECT
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'complete'),
    COUNT(*) FILTER (WHERE status = 'processing')
  INTO v_pending, v_complete, v_processing
  FROM cron_progress
  WHERE game_date = v_today;

  RAISE NOTICE '';
  RAISE NOTICE 'cron_progress for today (%): pending=% complete=% processing=%',
    v_today, v_pending, v_complete, v_processing;
END $$;
