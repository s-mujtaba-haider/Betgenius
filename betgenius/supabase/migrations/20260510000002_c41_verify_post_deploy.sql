-- C41 refactor verification @ post-deploy May 11 01:24 UTC. Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
BEGIN
  RAISE NOTICE '=== C41 verify post-deploy @ % ===', NOW();

  -- process-games errors in last hour
  RAISE NOTICE '';
  RAISE NOTICE '--- error_log process-games last 1h ---';
  FOR v_row IN
    SELECT created_at, phase, error_type, LEFT(error_message, 180) AS msg,
           context->>'severity' AS severity
    FROM error_log
    WHERE function_name = 'process-games'
      AND created_at > NOW() - INTERVAL '1 hour'
    ORDER BY created_at DESC
    LIMIT 20
  LOOP
    RAISE NOTICE '  [%] sev=% %::%  | %',
      v_row.created_at, COALESCE(v_row.severity, '(none)'),
      v_row.phase, v_row.error_type, v_row.msg;
  END LOOP;

  -- notifications_log last 1h (any function)
  RAISE NOTICE '';
  RAISE NOTICE '--- notifications_log last 1h ---';
  FOR v_row IN
    SELECT created_at, severity, title, LEFT(message, 100) AS msg, delivered_via
    FROM notifications_log
    WHERE created_at > NOW() - INTERVAL '1 hour'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  [%] sev=% via=% — % | %',
      v_row.created_at, v_row.severity, v_row.delivered_via, v_row.title, v_row.msg;
  END LOOP;

  -- run_log: did process-games write a row post-deploy?
  RAISE NOTICE '';
  RAISE NOTICE '--- run_log process-games last 30 min ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           LEFT(COALESCE(notes, '(no notes)'), 180) AS notes
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at > NOW() - INTERVAL '30 minutes'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  [%] status=% games=% recs=% notes=%',
      v_row.created_at, v_row.status, v_row.games_found, v_row.recommendations, v_row.notes;
  END LOOP;

  -- Specifically: any new C41 error types appear?
  SELECT COUNT(*) INTO v_count
  FROM error_log
  WHERE function_name = 'process-games'
    AND error_type IN ('recs_cache_write_failed','recs_cache_write_threw','rpc_upsert_failed','rpc_upsert_threw')
    AND created_at > '2026-05-11 01:23:00+00';
  RAISE NOTICE '';
  RAISE NOTICE 'C41 error types since deploy (01:23 UTC May 11): %  (expected 0 — no writes attempted on skip path)', v_count;
END $$;
