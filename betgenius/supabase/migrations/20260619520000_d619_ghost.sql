DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '[ghost] mlb_schedule (or wherever the games come from) for today:';
  -- Try common table names
  BEGIN
    FOR r IN
      SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name ILIKE '%mlb%schedule%'
    LOOP
      RAISE NOTICE '  table: %', r.table_name;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  (no mlb_schedule table)'; END;

  RAISE NOTICE '';
  RAISE NOTICE '[props] distinct home/away teams in props_cache today:';
  FOR r IN
    SELECT DISTINCT home_team, away_team
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
     ORDER BY home_team
  LOOP
    RAISE NOTICE '  home="%" away="%"', r.home_team, r.away_team;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[recs] distinct teams in recommendations_cache today (where the games come from):';
  FOR r IN
    SELECT DISTINCT
      COALESCE(team, '?') AS team,
      COALESCE(opponent, '?') AS opp
      FROM public.recommendations_cache
     WHERE sport='mlb' AND game_date::text = v_today::text
     ORDER BY team
     LIMIT 30
  LOOP
    RAISE NOTICE '  team="%" opp="%"', r.team, r.opp;
  END LOOP;
END $$;
