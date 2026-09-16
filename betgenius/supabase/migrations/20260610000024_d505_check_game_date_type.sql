DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pick_history' AND column_name='game_date'
  LOOP
    RAISE NOTICE '[D-505] pick_history.game_date data_type=%', r.data_type;
  END LOOP;
  FOR r IN SELECT game_date FROM public.pick_history_real WHERE game_date IS NOT NULL LIMIT 3
  LOOP
    RAISE NOTICE '  sample game_date=% (pg_typeof=%)', r.game_date, pg_typeof(r.game_date);
  END LOOP;
END $$;
