-- D-623 reproduce — try running the actual failing query under PostgREST's
-- statement_timeout (~8s) to see if 57014 fires.

DO $$ DECLARE r RECORD; v_start timestamptz; v_elapsed_ms numeric; BEGIN
  -- PostgREST typically uses statement_timeout=8s on Supabase. Set it to test.
  SET LOCAL statement_timeout TO '8s';

  RAISE NOTICE 'Reproducing d609 health-monitor probe (limit=1, order=placed_at desc):';

  -- §1 — bets table size
  FOR r IN SELECT count(*) AS n FROM public.bets LOOP
    RAISE NOTICE '[1] bets row count: %', r.n;
  END LOOP;

  -- §2 — pick_history row count
  FOR r IN SELECT count(*) AS n FROM public.pick_history LOOP
    RAISE NOTICE '[2] pick_history row count: %', r.n;
  END LOOP;

  -- §3 — Try the actual health probe query, time it
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT bet_id, user_id, placed_at, sport, is_matched
        FROM public.real_money_bets
       ORDER BY placed_at DESC, bet_id DESC
       LIMIT 1
    LOOP
      v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[3] HEALTH PROBE OK: bet_id=% placed=% sport=% matched=% (% ms)',
        r.bet_id, r.placed_at, r.sport, r.is_matched, v_elapsed_ms;
    END LOOP;
    IF NOT FOUND THEN
      v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[3] HEALTH PROBE returned 0 rows (% ms)', v_elapsed_ms;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[3] HEALTH PROBE ERROR: SQLSTATE=% MESSAGE=% (% ms)',
      SQLSTATE, SQLERRM, v_elapsed_ms;
  END;

  -- §4 — User-scoped query (Performance.tsx pattern)
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT bet_id, user_id, placed_at, sport, is_matched
        FROM public.real_money_bets
       WHERE user_id = '00000000-0000-0000-0000-000000000000'::uuid
       ORDER BY placed_at DESC, bet_id DESC
       LIMIT 50
    LOOP
      v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[4] USER-SCOPED: bet_id=% (% ms)', r.bet_id, v_elapsed_ms;
    END LOOP;
    IF NOT FOUND THEN
      v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[4] USER-SCOPED returned 0 rows (% ms)', v_elapsed_ms;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_elapsed_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[4] USER-SCOPED ERROR: SQLSTATE=% MESSAGE=% (% ms)',
      SQLSTATE, SQLERRM, v_elapsed_ms;
  END;

  -- §5 — EXPLAIN the failing probe to see plan + scan estimates
  RAISE NOTICE '';
  RAISE NOTICE '[5] EXPLAIN (health monitor query):';
  FOR r IN
    EXPLAIN (FORMAT TEXT)
    SELECT bet_id, user_id, placed_at, sport, is_matched
      FROM public.real_money_bets
     ORDER BY placed_at DESC, bet_id DESC
     LIMIT 1
  LOOP
    RAISE NOTICE '  %', r."QUERY PLAN";
  END LOOP;
END $$;
