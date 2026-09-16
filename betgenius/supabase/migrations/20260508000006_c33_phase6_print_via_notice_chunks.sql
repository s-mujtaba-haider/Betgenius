-- Print full view + function bodies via RAISE NOTICE in 200-char chunks
-- (small enough to avoid any PostgreSQL NOTICE truncation, plus we use
-- numeric prefixes so we can reassemble the full text correctly).

DO $$
DECLARE
  v_def TEXT;
  v_chunk_size CONSTANT INTEGER := 200;
  v_pos INTEGER;
  v_idx INTEGER;
  v_total INTEGER;
  v_funcs RECORD;
BEGIN
  ----------------------------------------------------------------
  RAISE NOTICE '====== real_money_bets view full body ======';
  SELECT pg_get_viewdef('public.real_money_bets'::regclass, true) INTO v_def;
  -- Replace newlines with literal "\n" sentinel so chunking doesn't break on them
  v_def := REPLACE(v_def, E'\n', '\n');
  v_def := REPLACE(v_def, E'\r', '');
  v_total := CEIL(LENGTH(v_def)::NUMERIC / v_chunk_size);
  v_idx := 1;
  v_pos := 1;
  WHILE v_pos <= LENGTH(v_def) LOOP
    RAISE NOTICE 'VIEW[%/%]: %', v_idx, v_total, SUBSTRING(v_def FROM v_pos FOR v_chunk_size);
    v_pos := v_pos + v_chunk_size;
    v_idx := v_idx + 1;
  END LOOP;

  ----------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '====== resolve_bet_pick_id() function body ======';
  FOR v_funcs IN
    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_bet_pick_id'
  LOOP
    v_def := REPLACE(v_funcs.prosrc, E'\n', '\n');
    v_def := REPLACE(v_def, E'\r', '');
    v_total := CEIL(LENGTH(v_def)::NUMERIC / v_chunk_size);
    v_idx := 1;
    v_pos := 1;
    WHILE v_pos <= LENGTH(v_def) LOOP
      RAISE NOTICE 'FUNC1[%/%]: %', v_idx, v_total, SUBSTRING(v_def FROM v_pos FOR v_chunk_size);
      v_pos := v_pos + v_chunk_size;
      v_idx := v_idx + 1;
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '====== settle_synthetic_hits(uuid) function body ======';
  FOR v_funcs IN
    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'settle_synthetic_hits'
  LOOP
    v_def := REPLACE(v_funcs.prosrc, E'\n', '\n');
    v_def := REPLACE(v_def, E'\r', '');
    v_total := CEIL(LENGTH(v_def)::NUMERIC / v_chunk_size);
    v_idx := 1;
    v_pos := 1;
    WHILE v_pos <= LENGTH(v_def) LOOP
      RAISE NOTICE 'FUNC2[%/%]: %', v_idx, v_total, SUBSTRING(v_def FROM v_pos FOR v_chunk_size);
      v_pos := v_pos + v_chunk_size;
      v_idx := v_idx + 1;
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '====== backtest_weights(...) function body ======';
  FOR v_funcs IN
    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'backtest_weights'
  LOOP
    v_def := REPLACE(v_funcs.prosrc, E'\n', '\n');
    v_def := REPLACE(v_def, E'\r', '');
    v_total := CEIL(LENGTH(v_def)::NUMERIC / v_chunk_size);
    v_idx := 1;
    v_pos := 1;
    WHILE v_pos <= LENGTH(v_def) LOOP
      RAISE NOTICE 'FUNC3[%/%]: %', v_idx, v_total, SUBSTRING(v_def FROM v_pos FOR v_chunk_size);
      v_pos := v_pos + v_chunk_size;
      v_idx := v_idx + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '====== END ======';
END $$;
