DO $$
DECLARE c INT;
BEGIN
  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name LIKE '%blowout%';
  RAISE NOTICE 'pick_history blowout cols: %', c;
  SELECT COUNT(*) INTO c FROM information_schema.tables
    WHERE table_schema='public' AND table_name='cache_game_lines';
  RAISE NOTICE 'cache_game_lines table exists: % (1=YES)', c;
END $$;
