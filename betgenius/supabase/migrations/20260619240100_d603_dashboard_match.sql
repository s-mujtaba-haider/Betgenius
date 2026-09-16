-- D-603 SHIP 1 follow-up — match the Dashboard's EXACT query to verify the
-- 9 / 195 / 5 numbers the user observed are honest scoping outcomes.
--
-- Dashboard.tsx fetchFromCache (line ~316-333):
--   SELECT * FROM recommendations_cache_sellable
--    WHERE game_date = gameDate AND sport = sport
--      AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
--    ORDER BY confidence DESC
--   Then JS filter: confidence >= 60 AND (showSecondaryMarkets || !is_secondary_market)
--   Defaults: showSecondaryMarkets = false → !is_secondary_market applies
--
-- gamesAnalyzed = distinct game_id from raw allPlayerProps
-- propsAnalyzed = allPlayerProps.length (the 195)
-- recommendations.length = playerPropsHigh.length (the 5)
--
-- READ-ONLY.

DO $$
DECLARE
  r            RECORD;
  v_yest_date  date := (now() AT TIME ZONE 'America/New_York')::date - 1;
  v_today_date date := (now() AT TIME ZONE 'America/New_York')::date;
  v_props_yest_raw          bigint;
  v_props_yest_60           bigint;
  v_props_yest_60_primary   bigint;
  v_games_yest              bigint;
  v_props_today_raw         bigint;
  v_props_today_60_primary  bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-603 FOLLOWUP — Dashboard exact-query match';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- =================== YESTERDAY ===================
  -- propsAnalyzed (the "195")
  SELECT count(*) INTO v_props_yest_raw
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_yest_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals');
  RAISE NOTICE '[YEST] propsAnalyzed (rec_cache_sellable ex game-side): %  (should be 195)',
    v_props_yest_raw;

  -- gamesAnalyzed (the "9") — distinct game_id from above
  SELECT count(DISTINCT game_id) INTO v_games_yest
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_yest_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals');
  RAISE NOTICE '[YEST] gamesAnalyzed (distinct game_id): %  (should be 9)', v_games_yest;

  -- After conf>=60 client-side filter
  SELECT count(*) INTO v_props_yest_60
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_yest_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
     AND confidence >= 60;
  RAISE NOTICE '[YEST] post-conf>=60 filter: %', v_props_yest_60;

  -- After conf>=60 AND !is_secondary_market filter (the "5")
  SELECT count(*) INTO v_props_yest_60_primary
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_yest_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
     AND confidence >= 60
     AND (is_secondary_market IS NULL OR is_secondary_market = false);
  RAISE NOTICE '[YEST] post-conf>=60 + !is_secondary: %  ← should be 5', v_props_yest_60_primary;

  -- Show the actual rendered rows
  RAISE NOTICE '';
  RAISE NOTICE '[YEST] The dashboard-rendered recommendations rows:';
  FOR r IN
    SELECT player_name, prop_type, line, pick_side,
           odds, confidence, is_secondary_market
      FROM public.recommendations_cache_sellable
     WHERE game_date = v_yest_date AND sport = 'mlb'
       AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
       AND confidence >= 60
       AND (is_secondary_market IS NULL OR is_secondary_market = false)
     ORDER BY confidence DESC, player_name
  LOOP
    RAISE NOTICE '  player=% prop=% line=% side=% odds=% conf=% secondary=%',
      r.player_name, r.prop_type, r.line, r.pick_side,
      r.odds, r.confidence, r.is_secondary_market;
  END LOOP;

  -- Confidence distribution to show why so few cross conf>=60
  RAISE NOTICE '';
  RAISE NOTICE '[YEST] confidence distribution across the 195 non-game-side sellable:';
  FOR r IN
    SELECT
      CASE
        WHEN confidence >= 80 THEN '80+'
        WHEN confidence >= 70 THEN '70-79'
        WHEN confidence >= 60 THEN '60-69'
        WHEN confidence >= 50 THEN '50-59'
        ELSE '<50'
      END AS bucket,
      count(*) AS n,
      count(*) FILTER (WHERE is_secondary_market = false OR is_secondary_market IS NULL) AS n_primary,
      count(*) FILTER (WHERE is_secondary_market = true) AS n_secondary
    FROM public.recommendations_cache_sellable
     WHERE game_date = v_yest_date AND sport = 'mlb'
       AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
     GROUP BY bucket
     ORDER BY bucket DESC
  LOOP
    RAISE NOTICE '  conf %  n=% primary=% secondary=%',
      r.bucket, r.n, r.n_primary, r.n_secondary;
  END LOOP;

  -- =================== TODAY (slate just rolled) ===================
  RAISE NOTICE '';
  SELECT count(*) INTO v_props_today_raw
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_today_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals');
  SELECT count(*) INTO v_props_today_60_primary
    FROM public.recommendations_cache_sellable
   WHERE game_date = v_today_date AND sport = 'mlb'
     AND prop_type NOT IN ('spread','game_total','h2h','spreads','totals')
     AND confidence >= 60
     AND (is_secondary_market IS NULL OR is_secondary_market = false);
  RAISE NOTICE '[TODAY] propsAnalyzed: %  recs: %', v_props_today_raw, v_props_today_60_primary;

  RAISE NOTICE '';
  RAISE NOTICE 'D-603 follow-up complete.';
END $$;
