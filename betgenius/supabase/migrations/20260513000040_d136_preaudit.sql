DO $$
DECLARE n1 INT; n2 INT; n3 INT;
BEGIN
  SELECT COUNT(*) INTO n1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name LIKE '%low_min%';
  SELECT COUNT(*) INTO n2 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights' AND column_name LIKE '%low_min%';
  SELECT COUNT(*) INTO n3 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache' AND column_name LIKE '%low_min%';
  RAISE NOTICE 'pick_history %%low_min%% cols: %', n1;
  RAISE NOTICE 'algorithm_weights %%low_min%% cols: %', n2;
  RAISE NOTICE 'recommendations_cache %%low_min%% cols: %', n3;
END $$;
