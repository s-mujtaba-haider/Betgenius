DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== tables matching name patterns ===';
  FOR r IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name LIKE '%spread%' OR table_name LIKE '%game%' OR table_name LIKE '%odds%' OR table_name LIKE '%event%')
    ORDER BY table_name
  LOOP RAISE NOTICE 'table=%', r.table_name; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== recommendations_cache distinct prop_type last 3 days ===';
  FOR r IN
    SELECT prop_type, COUNT(*) AS n FROM recommendations_cache
    WHERE game_date >= CURRENT_DATE - 3 GROUP BY prop_type ORDER BY n DESC LIMIT 12
  LOOP RAISE NOTICE 'pt=% n=%', RPAD(r.prop_type, 20), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== spread + game_total sample (most recent 6) ===';
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, odds, confidence, game_date,
           CASE WHEN team IS NOT NULL THEN LEFT(team, 16) ELSE 'NULL' END AS team_,
           CASE WHEN opponent IS NOT NULL THEN LEFT(opponent, 16) ELSE 'NULL' END AS opp_
    FROM recommendations_cache
    WHERE prop_type IN ('spread', 'game_total', 'game_spread', 'totals', 'h2h')
    ORDER BY game_date DESC, id DESC LIMIT 6
  LOOP
    RAISE NOTICE 'pt=% gd=% player=% team=% opp=% side=% line=% odds=% conf=%',
      RPAD(r.prop_type, 12), r.game_date, RPAD(r.player_name, 26),
      r.team_, r.opp_, RPAD(r.pick_side, 6), r.line, r.odds, r.confidence;
  END LOOP;
END $$;
