-- URGENT diagnostic — dashboard empty May 9 14:18 UTC despite process-games
-- claiming success. Read-only NOTICE output across multiple suspect tables.

DO $$
DECLARE
  v_row RECORD;
  v_today_text TEXT;
  v_today_date DATE;
  v_count INTEGER;
BEGIN
  v_today_text := TO_CHAR((NOW() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_today_date := (NOW() AT TIME ZONE 'America/New_York')::date;
  RAISE NOTICE '=== Dashboard-empty diagnosis @ % ===', NOW();
  RAISE NOTICE 'Today ET as TEXT YYYYMMDD: %  as DATE: %', v_today_text, v_today_date;

  -- ============================================================
  -- 1. Schema check — what type is recommendations_cache.game_date NOW?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 1. Column types post-C33-Phase-6 ---';
  FOR v_row IN
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('pick_history', 'recommendations_cache')
      AND column_name LIKE 'game_date%'
    ORDER BY table_name, column_name
  LOOP
    RAISE NOTICE '  %.%  type=% nullable=%', v_row.table_name, v_row.column_name, v_row.data_type, v_row.is_nullable;
  END LOOP;
  RAISE NOTICE '(Expected: only game_date columns exist (DATE type). game_date_new should be GONE.)';

  -- ============================================================
  -- 2. recommendations_cache — does ANY row exist for today (TEXT format)?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 2. recommendations_cache state for today ---';
  -- 2a: Today by DATE
  SELECT COUNT(*) INTO v_count FROM recommendations_cache WHERE game_date = v_today_date;
  RAISE NOTICE '  rows where game_date = %::date : %', v_today_date, v_count;
  -- 2b: All recent rows (last 3 days regardless)
  RAISE NOTICE '  most-recent created_at + game_date in recommendations_cache (last 5):';
  FOR v_row IN
    SELECT id, created_at, game_date, sport, player_name, prop_type, confidence
    FROM recommendations_cache
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '    id=% created=% game_date=% sport=% % % conf=%',
      v_row.id, v_row.created_at, v_row.game_date, v_row.sport,
      v_row.player_name, v_row.prop_type, v_row.confidence;
  END LOOP;
  -- 2c: per-day breakdown last 7 days
  RAISE NOTICE '  per-day count last 7 days:';
  FOR v_row IN
    SELECT game_date, COUNT(*) AS n
    FROM recommendations_cache
    WHERE game_date >= v_today_date - 7
    GROUP BY game_date
    ORDER BY game_date DESC
  LOOP
    RAISE NOTICE '    %  : %', v_row.game_date, v_row.n;
  END LOOP;

  -- ============================================================
  -- 3. error_log today — any cache_write_failed entries?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 3. error_log today (process-games) ---';
  FOR v_row IN
    SELECT created_at, function_name, phase, error_type, LEFT(error_message, 240) AS msg
    FROM error_log
    WHERE function_name IN ('process-games', 'analyze-pick')
      AND created_at >= NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  [%] % :: % :: % | %',
      v_row.created_at, v_row.function_name, v_row.phase, v_row.error_type, v_row.msg;
  END LOOP;

  -- ============================================================
  -- 4. pick_history — same question, did writes today succeed there?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 4. pick_history rows from today ---';
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE created_at >= DATE_TRUNC('day', NOW());
  RAISE NOTICE '  pick_history rows created today: %', v_count;
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE game_date = v_today_date;
  RAISE NOTICE '  pick_history rows where game_date = % : %', v_today_date, v_count;

  -- ============================================================
  -- 5. resolve-picks cron status + last run + bets pending
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 5. resolve-picks cron + recent runs ---';
  FOR v_row IN
    SELECT jobid, jobname, schedule, active, LEFT(command, 200) AS cmd
    FROM cron.job
    WHERE jobname ILIKE '%resolve%' OR jobid IN (5, 6, 8)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid=% name=% schedule=% active=%', v_row.jobid, v_row.jobname, v_row.schedule, v_row.active;
  END LOOP;
  RAISE NOTICE '  resolve-picks recent run_log (last 5):';
  FOR v_row IN
    SELECT created_at, status, LEFT(COALESCE(notes, '(no notes)'), 200) AS notes_preview
    FROM run_log
    WHERE function_name = 'resolve-picks'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '    [%] status=% notes=%', v_row.created_at, v_row.status, v_row.notes_preview;
  END LOOP;

  -- ============================================================
  -- 6. bets — pending count + schema (no game_date column)
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 6. bets table state ---';
  SELECT COUNT(*) INTO v_count FROM bets WHERE status = 'pending';
  RAISE NOTICE '  total pending bets: %', v_count;
  SELECT COUNT(*) INTO v_count FROM bets WHERE status = 'pending' AND placed_at < NOW() - INTERVAL '24 hours';
  RAISE NOTICE '  pending bets older than 24h (should be small if resolve-picks healthy): %', v_count;
  RAISE NOTICE '  bets columns matching *date* or *placed* or *status*:';
  FOR v_row IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bets'
      AND (column_name ~* 'date|placed|status|settle')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '    bets.%  type=%', v_row.column_name, v_row.data_type;
  END LOOP;

  -- ============================================================
  -- 7. Sanity — does '20260509' (TEXT) cast to DATE in current postgres config?
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 7. TEXT-as-DATE cast probe (Dashboard query format) ---';
  BEGIN
    PERFORM '20260509'::date;
    RAISE NOTICE '  ''20260509''::date — WORKS (Postgres accepts compact YYYYMMDD)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  ''20260509''::date — FAILS — % / SQLSTATE=%', SQLERRM, SQLSTATE;
  END;

  -- Try a PostgREST-style query against game_date=eq.20260509
  SELECT COUNT(*) INTO v_count FROM recommendations_cache WHERE game_date::TEXT = '20260509';
  RAISE NOTICE '  recommendations_cache where game_date::text = ''20260509'': % (Dashboard-style filter)', v_count;
  SELECT COUNT(*) INTO v_count FROM recommendations_cache WHERE game_date = '20260509'::date;
  RAISE NOTICE '  recommendations_cache where game_date = ''20260509''::date: %', v_count;
  SELECT COUNT(*) INTO v_count FROM recommendations_cache WHERE game_date = '2026-05-09'::date;
  RAISE NOTICE '  recommendations_cache where game_date = ''2026-05-09''::date: %', v_count;

  -- ============================================================
  -- 8. cron_progress for today (already known but include for completeness)
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '--- 8. cron_progress today ---';
  FOR v_row IN
    SELECT id, game_id, status, started_at, completed_at,
           home_team, away_team
    FROM cron_progress
    WHERE game_date = v_today_text
    ORDER BY game_time
  LOOP
    RAISE NOTICE '  id=% % vs % :: status=% started=% completed=%',
      v_row.id, v_row.away_team, v_row.home_team,
      v_row.status, v_row.started_at, v_row.completed_at;
  END LOOP;
END $$;
