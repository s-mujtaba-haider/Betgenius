DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-511 game-lookup] sample props_cache rows for game markets today:';
  FOR r IN
    SELECT prop_type, home_team, away_team, pick_side, line, bookmaker, odds,
           player_name AS pn
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260611'
      AND prop_type IN ('h2h','spreads','totals')
      AND home_team='Pittsburgh Pirates'
    ORDER BY prop_type, bookmaker LIMIT 12
  LOOP RAISE NOTICE '  prop=% h=% a=% side=% line=% book=% odds=% pn=%',
    r.prop_type, r.home_team, r.away_team, r.pick_side, r.line, r.bookmaker, r.odds, r.pn; END LOOP;
END $$;
