-- D-608 verify — exercise the corrected fetchBets keyset query shape
-- against the LIVE real_money_bets view to confirm:
--   1. The view EXPOSES `bet_id` (not `id`) — confirms the root cause.
--   2. The corrected ORDER BY (placed_at DESC, bet_id DESC) parses cleanly.
--   3. The corrected keyset filter
--      placed_at <= cursor AND (placed_at < cursor OR bet_id < cursor_bet_id)
--      returns rows without error.
--
-- The pre-D-608 (broken) query used `id` which the view doesn't expose →
-- PostgREST 400 Bad Request on every Performance page load.
--
-- READ-ONLY.

DO $$
DECLARE
  r RECORD;
  v_has_id bool;
  v_has_bet_id bool;
  v_cursor_placed_at timestamptz;
  v_cursor_bet_id uuid;
  v_n_rows bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-608 verify — real_money_bets schema + corrected query';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — Confirm root cause: the view exposes bet_id, not id
  RAISE NOTICE '';
  RAISE NOTICE '[A] Column-existence check on view public.real_money_bets:';
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='real_money_bets' AND column_name='id'
  ) INTO v_has_id;
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='real_money_bets' AND column_name='bet_id'
  ) INTO v_has_bet_id;
  RAISE NOTICE '  column `id` exists:     %  (expected FALSE)', v_has_id;
  RAISE NOTICE '  column `bet_id` exists: %  (expected TRUE)', v_has_bet_id;

  RAISE NOTICE '';
  RAISE NOTICE '[A.cols] All real_money_bets columns:';
  FOR r IN
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='real_money_bets'
     ORDER BY ordinal_position
  LOOP RAISE NOTICE '  %  type=%', r.column_name, r.data_type; END LOOP;

  -- §B — Run the corrected PAGE 0 query (PostgREST translates user_id filter
  --      + ORDER BY to plain SQL). Confirm no error + at least 1 row exists.
  SELECT count(*) INTO v_n_rows FROM public.real_money_bets;
  RAISE NOTICE '';
  RAISE NOTICE '[B] real_money_bets total row count: %', v_n_rows;

  IF v_n_rows = 0 THEN
    RAISE NOTICE '  (no rows to test keyset on; queries below skip)';
    RETURN;
  END IF;

  -- Synthesize a cursor at the second row to test page N>=1
  SELECT placed_at, bet_id INTO v_cursor_placed_at, v_cursor_bet_id
    FROM public.real_money_bets
   ORDER BY placed_at DESC, bet_id DESC OFFSET 0 LIMIT 1;
  RAISE NOTICE '[B] head cursor: placed_at=% bet_id=%', v_cursor_placed_at, v_cursor_bet_id;

  -- §B.1 — page 0 shape
  RAISE NOTICE '';
  RAISE NOTICE '[B.1] EXPLAIN page 0 (no cursor, ORDER BY placed_at.desc,bet_id.desc):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.real_money_bets
     ORDER BY placed_at DESC, bet_id DESC LIMIT 1000
  $q$)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §B.2 — page N (keyset filter)
  RAISE NOTICE '';
  RAISE NOTICE '[B.2] EXPLAIN page N (keyset filter):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.real_money_bets
     WHERE placed_at <= %L
       AND (placed_at < %L OR bet_id < %L)
     ORDER BY placed_at DESC, bet_id DESC LIMIT 1000
  $q$, v_cursor_placed_at, v_cursor_placed_at, v_cursor_bet_id)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: no SQL errors + non-empty plans = corrected';
  RAISE NOTICE 'query shape is valid against the live view.';
END $$;
