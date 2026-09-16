DO $$
DECLARE r RECORD; v_n INT; v_now TIMESTAMPTZ := NOW(); BEGIN
  RAISE NOTICE '──── D-686 — NOW=% ────', v_now;

  -- 1) Find tables that might hold tonight's games
  RAISE NOTICE 'candidate game tables:';
  FOR r IN
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND (relname IN ('games','games_mlb','mlb_games','cache_mlb_game_scoreboard','cache_mlb_games')
           OR relname LIKE '%scoreboard%' OR relname LIKE '%games_today%')
    ORDER BY relname
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', r.relname) INTO v_n;
    RAISE NOTICE '  % rows=%', r.relname, v_n;
  END LOOP;

  -- 2) cache_mlb_game_scoreboard column inspection
  RAISE NOTICE 'cache_mlb_game_scoreboard columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_mlb_game_scoreboard'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  col % (%)', r.column_name, r.data_type;
  END LOOP;

  -- 3) games table column inspection (if exists)
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname='games') THEN
    RAISE NOTICE 'games columns:';
    FOR r IN
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='games'
      ORDER BY ordinal_position LIMIT 20
    LOOP
      RAISE NOTICE '  games col % (%)', r.column_name, r.data_type;
    END LOOP;
  END IF;
END $$;
