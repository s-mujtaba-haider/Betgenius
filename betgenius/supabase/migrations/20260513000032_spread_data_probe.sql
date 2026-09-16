-- Locate spread storage path: probe props_cache schema + any spread/game_total rows.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== props_cache columns ===';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 22), r.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== distinct prop_type values in props_cache (last 3 days) ===';
  FOR r IN
    SELECT prop_type, COUNT(*) AS n
    FROM props_cache
    WHERE game_date::TEXT >= to_char(CURRENT_DATE - 3, 'YYYYMMDD')
    GROUP BY prop_type ORDER BY n DESC LIMIT 20
  LOOP
    RAISE NOTICE 'prop_type=% n=%', RPAD(r.prop_type, 18), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== spread/game_total rows: 5 recent samples ===';
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, odds, bookmaker, home_team, away_team, event_id, game_date
    FROM props_cache
    WHERE prop_type IN ('spread','game_total','game_spread','h2h','totals')
    ORDER BY game_date DESC, prop_type LIMIT 10
  LOOP
    RAISE NOTICE 'pt=% gd=% home=% away=% side=% line=% odds=% book=%',
      RPAD(r.prop_type, 12), r.game_date,
      RPAD(COALESCE(r.home_team, 'NULL'), 22),
      RPAD(COALESCE(r.away_team, 'NULL'), 22),
      RPAD(r.pick_side, 6), r.line, r.odds, RPAD(COALESCE(r.bookmaker, 'NULL'), 14);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== pick_history columns referencing spread/game ===';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND (column_name LIKE '%spread%' OR column_name LIKE '%game_total%' OR column_name LIKE 'home%' OR column_name LIKE 'away%')
    ORDER BY column_name
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 24), r.data_type;
  END LOOP;
END $$;
