DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-508] error_log columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='error_log'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  % %', r.column_name, r.data_type; END LOOP;

  RAISE NOTICE '[D-508] full checkpoint rows from process-games-mlb last 10 min:';
  FOR r IN
    SELECT * FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '10 minutes'
      AND function_name = 'process-games-mlb'
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  row=%', row_to_json(r); END LOOP;
END $$;
