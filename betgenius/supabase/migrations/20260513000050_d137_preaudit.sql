DO $$
DECLARE col_count INT; tbl_count INT; w_count INT; cache_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name LIKE '%blowout%';
  SELECT COUNT(*) INTO w_count FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights' AND column_name LIKE '%blowout%';
  SELECT COUNT(*) INTO cache_count FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache' AND column_name LIKE '%blowout%';
  SELECT COUNT(*) INTO tbl_count FROM information_schema.tables
    WHERE table_schema='public' AND table_name='cache_game_lines';
  RAISE NOTICE 'pick_history blowout cols: %', col_count;
  RAISE NOTICE 'algorithm_weights blowout cols: %', w_count;
  RAISE NOTICE 'recommendations_cache blowout cols: %', cache_count;
  RAISE NOTICE 'cache_game_lines table exists: % (1=YES)', tbl_count;
END $$;
