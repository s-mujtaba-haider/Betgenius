DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE 'pick_history columns:';
  FOR r IN SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pick_history' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  %', r.column_name;
  END LOOP;
END $$;
