DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-626 UI diagnose — READ-ONLY — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — game_total in props_cache today (RAW data — is fetch working?)
  RAISE NOTICE '';
  RAISE NOTICE '[A] props_cache today by prop_type (does totals data EXIST?):';
  FOR r IN
    SELECT prop_type, count(*) AS n,
           count(DISTINCT (home_team, away_team)) AS distinct_games,
           count(DISTINCT bookmaker) AS distinct_books
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
     GROUP BY prop_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  prop_type=% rows=% games=% books=%', r.prop_type, r.n, r.distinct_games, r.distinct_books;
  END LOOP;

  -- §B — sample game_total rows from props_cache today
  RAISE NOTICE '';
  RAISE NOTICE '[B] Sample 5 game_total rows in props_cache today:';
  FOR r IN
    SELECT home_team, away_team, line, odds, pick_side, bookmaker
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today AND prop_type = 'totals'
     ORDER BY home_team
     LIMIT 5
  LOOP
    RAISE NOTICE '  %|% line=% odds=% side=% book=%', r.home_team, r.away_team, r.line, r.odds, r.pick_side, r.bookmaker;
  END LOOP;

  -- §C — sample batter_total_bases rows
  RAISE NOTICE '';
  RAISE NOTICE '[C] Sample 5 batter_total_bases rows in props_cache today:';
  FOR r IN
    SELECT player_name, line, odds, pick_side, bookmaker
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
       AND prop_type ILIKE '%total_bases%'
     ORDER BY player_name
     LIMIT 5
  LOOP
    RAISE NOTICE '  player=% line=% odds=% side=% book=%', r.player_name, r.line, r.odds, r.pick_side, r.bookmaker;
  END LOOP;

  -- §D — recommendations_cache today by prop_type — what's SCORED?
  RAISE NOTICE '';
  RAISE NOTICE '[D] recommendations_cache today by prop_type (what made it past scoring):';
  FOR r IN
    SELECT COALESCE(prop_type,'(null)') AS prop, count(*) AS n,
           min(confidence) AS min_conf, max(confidence) AS max_conf
      FROM public.recommendations_cache
     WHERE sport='mlb' AND game_date::text = (now() AT TIME ZONE 'America/New_York')::date::text
     GROUP BY prop_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  prop=% count=% conf_range=[% .. %]', r.prop, r.n, r.min_conf, r.max_conf;
  END LOOP;

  -- §E — pick_history today by market (the "we scored these" record)
  RAISE NOTICE '';
  RAISE NOTICE '[E] pick_history today by mlb_market_type:';
  FOR r IN
    SELECT COALESCE(mlb_market_type,'(null)') AS market, count(*) AS n,
           count(*) FILTER (WHERE recommendation_shown = true) AS shown
      FROM public.pick_history
     WHERE sport='mlb' AND game_date = (now() AT TIME ZONE 'America/New_York')::date
       AND is_synthetic = false
     GROUP BY mlb_market_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  market=% scored=% shown_on_dash=%', r.market, r.n, r.shown;
  END LOOP;

  -- §F — product_market_config — what's officially sellable?
  RAISE NOTICE '';
  RAISE NOTICE '[F] product_market_config (sellable config):';
  FOR r IN
    SELECT * FROM information_schema.columns WHERE table_schema='public' AND table_name='product_market_config' ORDER BY ordinal_position
  LOOP
    -- list columns; details follow
    NULL;
  END LOOP;
  FOR r IN
    SELECT * FROM public.product_market_config
  LOOP
    RAISE NOTICE '  %', to_jsonb(r);
  END LOOP;
END $$;
