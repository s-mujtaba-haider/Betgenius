-- When did pick_history last receive a player-prop row?
DO $$
DECLARE
  v_row RECORD;
  v_last_player_pick TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  SELECT created_at INTO v_last_player_pick
  FROM pick_history
  WHERE prop_type NOT IN ('spread', 'game_total')
    AND source = 'process-games'
  ORDER BY created_at DESC
  LIMIT 1;
  RAISE NOTICE 'last player-prop pick_history row created (source=process-games): %', v_last_player_pick;

  -- Per-day player-prop count last 14 days
  RAISE NOTICE '';
  RAISE NOTICE 'player-prop pick_history rows per game_date, last 14 days:';
  FOR v_row IN
    SELECT game_date, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE source = 'process-games') AS from_cron
    FROM pick_history
    WHERE prop_type NOT IN ('spread', 'game_total')
      AND game_date >= CURRENT_DATE - 14
    GROUP BY game_date
    ORDER BY game_date DESC
  LOOP
    RAISE NOTICE '  %: total=% from_cron=%', v_row.game_date, v_row.n, v_row.from_cron;
  END LOOP;

  -- All distinct sources
  RAISE NOTICE '';
  RAISE NOTICE 'pick_history sources distribution last 14 days:';
  FOR v_row IN
    SELECT source, prop_type, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY source, prop_type
    ORDER BY n DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  source=% prop_type=%: %', COALESCE(v_row.source, '(null)'), v_row.prop_type, v_row.n;
  END LOOP;
END $$;
