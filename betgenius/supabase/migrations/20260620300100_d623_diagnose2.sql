DO $$ DECLARE r RECORD; v_def text; BEGIN
  -- §A — get the full view definition by chunking
  SELECT pg_get_viewdef('public.real_money_bets'::regclass, true) INTO v_def;
  RAISE NOTICE '[A] view length = % chars', length(v_def);
  RAISE NOTICE '── view definition chunks (each ≤ 800 chars) ──';
  FOR i IN 0..(length(v_def) / 800) LOOP
    RAISE NOTICE '[chunk %] %', i, SUBSTRING(v_def FROM (i*800)+1 FOR 800);
  END LOOP;
END $$;
