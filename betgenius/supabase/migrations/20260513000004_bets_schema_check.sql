-- Schema probe for `bets` columns before retrying orphan audit.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== bets table columns ===';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bets'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 24), r.data_type;
  END LOOP;
END $$;
