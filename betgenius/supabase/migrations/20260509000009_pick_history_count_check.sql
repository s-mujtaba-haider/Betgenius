-- Why does cron_progress show 145 props_scored but pick_history only 2 today?
DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
BEGIN
  -- Total today (any criteria)
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE created_at >= DATE_TRUNC('day', NOW());
  RAISE NOTICE 'pick_history created_at >= today UTC: %', v_count;

  SELECT COUNT(*) INTO v_count FROM pick_history WHERE game_date = CURRENT_DATE;
  RAISE NOTICE 'pick_history game_date = CURRENT_DATE: %', v_count;

  SELECT COUNT(*) INTO v_count FROM pick_history WHERE created_at > '2026-05-09 16:33:42+00';
  RAISE NOTICE 'pick_history created_at > deploy time: %', v_count;

  RAISE NOTICE '';
  RAISE NOTICE 'last 5 pick_history rows:';
  FOR v_row IN
    SELECT id, created_at, player_name, prop_type, pick_side, game_date, source
    FROM pick_history
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  [%] % %/% game_date=% source=%',
      v_row.created_at, v_row.player_name, v_row.prop_type, v_row.pick_side, v_row.game_date, v_row.source;
  END LOOP;

  -- Spot check — find rows for current Pistons/Cavs game (game_id from cron_progress=66)
  RAISE NOTICE '';
  RAISE NOTICE 'pick_history rows from today by source:';
  FOR v_row IN
    SELECT source, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= DATE_TRUNC('day', NOW())
    GROUP BY source
  LOOP
    RAISE NOTICE '  %: %', COALESCE(v_row.source, '(null)'), v_row.n;
  END LOOP;
END $$;
