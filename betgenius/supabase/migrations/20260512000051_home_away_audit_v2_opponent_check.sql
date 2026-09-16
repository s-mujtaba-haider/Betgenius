-- Follow-up: is the parallel `opponent` field also missing from the ESPN
-- gamelog payload? If opponent is populated but is_home is NULL, the field
-- name in fetchGameLog (eventInfo.homeAway) is the wrong API key — ESPN
-- likely uses a different field name in the events object.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== Opponent field population in cache_player_game_logs ===';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE opponent IS NULL) AS null_opp,
      COUNT(*) FILTER (WHERE opponent = '') AS empty_opp,
      COUNT(*) FILTER (WHERE opponent IS NOT NULL AND opponent <> '') AS populated
    FROM cache_player_game_logs
  LOOP
    RAISE NOTICE 'total=% null_opp=% empty_opp=% populated=%',
      r.total, r.null_opp, r.empty_opp, r.populated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Sample 5 rows showing opponent vs is_home vs minutes ===';
  FOR r IN
    SELECT player_name, game_date, opponent, is_home,
      minutes, points
    FROM cache_player_game_logs
    WHERE opponent IS NOT NULL AND opponent <> ''
    ORDER BY game_date DESC
    LIMIT 5
  LOOP
    RAISE NOTICE 'player=% date=% opp=% is_home=% min=% pts=%',
      RPAD(r.player_name, 22), r.game_date, RPAD(COALESCE(r.opponent, 'NULL'), 16),
      COALESCE(r.is_home::TEXT, 'NULL'), r.minutes, r.points;
  END LOOP;
END $$;
