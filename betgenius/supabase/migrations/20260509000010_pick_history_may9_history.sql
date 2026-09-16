-- Why are player-prop pick_history writes for today missing?
DO $$
DECLARE
  v_count INTEGER;
  v_row RECORD;
BEGIN
  -- All pick_history with game_date = today, regardless of created_at
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE game_date = CURRENT_DATE;
  RAISE NOTICE 'pick_history game_date=CURRENT_DATE: % (any created_at)', v_count;

  -- Specifically player-prop rows for today
  SELECT COUNT(*) INTO v_count
  FROM pick_history
  WHERE game_date = CURRENT_DATE
    AND prop_type NOT IN ('spread', 'game_total');
  RAISE NOTICE 'player-prop pick_history rows for today: %', v_count;

  -- Sample player rows for today
  RAISE NOTICE '';
  RAISE NOTICE 'Player-prop pick_history rows for today (top 5 by created_at):';
  FOR v_row IN
    SELECT id, created_at, player_name, prop_type, pick_side, line, source
    FROM pick_history
    WHERE game_date = CURRENT_DATE
      AND prop_type NOT IN ('spread', 'game_total')
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  [%] % %/% line=% source=%',
      v_row.created_at, v_row.player_name, v_row.prop_type, v_row.pick_side, v_row.line, v_row.source;
  END LOOP;

  -- For comparison: yesterday's player-prop rows count
  SELECT COUNT(*) INTO v_count
  FROM pick_history
  WHERE game_date = CURRENT_DATE - 1
    AND prop_type NOT IN ('spread', 'game_total');
  RAISE NOTICE '';
  RAISE NOTICE 'Yesterday (May 8) player-prop pick_history count: %', v_count;
END $$;
