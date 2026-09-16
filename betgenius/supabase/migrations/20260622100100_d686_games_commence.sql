DO $$
DECLARE r RECORD; v_n INT; BEGIN
  -- Look for commence_time / event_time columns to find game start time
  RAISE NOTICE 'tables with commence_time:';
  FOR r IN
    SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN ('commence_time','event_time','game_time','start_time')
    ORDER BY table_name LIMIT 15
  LOOP
    RAISE NOTICE '  table %', r.table_name;
  END LOOP;

  -- Tonight's games via props_cache (most likely to have commence_time)
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname='props_cache') THEN
    RAISE NOTICE 'props_cache cols (first 20):';
    FOR r IN SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='props_cache' ORDER BY ordinal_position LIMIT 20
    LOOP
      RAISE NOTICE '  prop col %', r.column_name;
    END LOOP;
  END IF;

  -- recommendations_cache cols
  RAISE NOTICE 'recommendations_cache cols:';
  FOR r IN SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache' ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  rec col %', r.column_name;
  END LOOP;
END $$;
