-- Find where spread data lives. Probe all public tables for spread/game_total markets.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== tables in public with "spread" or "game" or "odds" in name ===';
  FOR r IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name LIKE '%spread%' OR table_name LIKE '%game%' OR table_name LIKE '%odds%' OR table_name LIKE '%event%')
    ORDER BY table_name
  LOOP
    RAISE NOTICE 'table=%', r.table_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== recommendations_cache prop_type distribution last 3 days ===';
  FOR r IN
    SELECT prop_type, COUNT(*) AS n
    FROM recommendations_cache
    WHERE game_date::TEXT >= to_char(CURRENT_DATE - 3, 'YYYYMMDD')
    GROUP BY prop_type ORDER BY n DESC LIMIT 10
  LOOP
    RAISE NOTICE 'pt=% n=%', RPAD(r.prop_type, 20), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== recommendations_cache: 3 most recent spread/game_total rows ===';
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, odds, game_date
    FROM recommendations_cache
    WHERE prop_type IN ('spread','game_total','game_spread')
    ORDER BY game_date DESC LIMIT 5
  LOOP
    RAISE NOTICE 'pt=% gd=% player=% side=% line=% odds=%',
      RPAD(r.prop_type, 14), r.game_date, RPAD(r.player_name, 26),
      RPAD(r.pick_side, 6), r.line, r.odds;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== recommendations_cache columns ===';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 24), r.data_type;
  END LOOP;
END $$;
