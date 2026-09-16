DO $$ DECLARE r RECORD; v_start timestamptz; v_ms numeric; BEGIN
  SET LOCAL statement_timeout TO '8s';

  -- §1 — timing of user_id-scoped probe (sentinel UUID)
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT bet_id, user_id, placed_at, sport, is_matched
        FROM public.real_money_bets
       WHERE user_id = '00000000-0000-0000-0000-000000000000'::uuid
       ORDER BY placed_at DESC, bet_id DESC
       LIMIT 1
    LOOP
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[1] PROBE row: bet_id=% (% ms)', r.bet_id, v_ms;
    END LOOP;
    IF NOT FOUND THEN
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[1] PROBE 0 rows (% ms) — view exercised, returns empty for sentinel UUID', v_ms;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[1] PROBE ERROR: SQLSTATE=% MSG=% (% ms)', SQLSTATE, SQLERRM, v_ms;
  END;

  -- §2 — EXPLAIN of user_id-scoped probe
  RAISE NOTICE '';
  RAISE NOTICE '[2] EXPLAIN:';
  FOR r IN
    EXPLAIN (FORMAT TEXT)
    SELECT bet_id, user_id, placed_at, sport, is_matched
      FROM public.real_money_bets
     WHERE user_id = '00000000-0000-0000-0000-000000000000'::uuid
     ORDER BY placed_at DESC, bet_id DESC
     LIMIT 1
  LOOP
    RAISE NOTICE '  %', r."QUERY PLAN";
  END LOOP;

  -- §3 — try with a REAL user_id to ensure the probe ALSO returns rows
  -- if a real user has bets — proving the view actually exercises
  RAISE NOTICE '';
  RAISE NOTICE '[3] Sample real user_ids in bets:';
  FOR r IN
    SELECT user_id, count(*) AS n
      FROM public.bets
     WHERE user_id IS NOT NULL
     GROUP BY user_id
     ORDER BY count(*) DESC
     LIMIT 3
  LOOP
    RAISE NOTICE '  user_id=% bets=%', r.user_id, r.n;
  END LOOP;

  -- §4 — what about a "no rows" condition that still exercises the view?
  -- Try LIMIT 0
  RAISE NOTICE '';
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT bet_id FROM public.real_money_bets LIMIT 0
    LOOP
      NULL;
    END LOOP;
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[4] LIMIT 0 probe (no rows expected): % ms', v_ms;
  EXCEPTION WHEN OTHERS THEN
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[4] LIMIT 0 ERROR: SQLSTATE=% MSG=% (% ms)', SQLSTATE, SQLERRM, v_ms;
  END;
END $$;
