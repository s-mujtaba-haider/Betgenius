DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'props_cache columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='props_cache' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;
END $$;
