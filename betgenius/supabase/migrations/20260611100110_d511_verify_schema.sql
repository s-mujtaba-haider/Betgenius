DO $$
DECLARE r RECORD; v_cnt INT;
BEGIN
  SELECT count(*) INTO v_cnt FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pick_history'
     AND column_name IN ('closing_odds','closing_line','clv_pct',
                         'closing_captured_at','closing_capture_reason');
  RAISE NOTICE '[D-511 verify] CLV columns present: % of 5', v_cnt;

  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND column_name ~ 'closing|clv'
    ORDER BY column_name
  LOOP RAISE NOTICE '  %  %', r.column_name, r.data_type; END LOOP;

  SELECT count(*) INTO v_cnt FROM pg_indexes
   WHERE indexname='idx_ph_closing_pending';
  RAISE NOTICE '[D-511 verify] idx_ph_closing_pending exists: %', v_cnt;
END $$;
