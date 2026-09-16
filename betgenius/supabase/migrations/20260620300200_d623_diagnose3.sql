DO $$ DECLARE v_def text; v_len int; v_pos int; v_chunk text; BEGIN
  SELECT regexp_replace(pg_get_viewdef('public.real_money_bets'::regclass, true), E'[\\n\\r]+', ' ', 'g') INTO v_def;
  v_len := length(v_def);
  RAISE NOTICE 'view length = %', v_len;
  v_pos := 1;
  WHILE v_pos <= v_len LOOP
    v_chunk := substring(v_def from v_pos for 400);
    RAISE NOTICE 'pos=% : %', v_pos, v_chunk;
    v_pos := v_pos + 400;
  END LOOP;
END $$;
