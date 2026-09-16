DO $$ DECLARE r RECORD; v_start timestamptz; v_ms numeric; v_cutoff timestamptz; BEGIN
  SET LOCAL statement_timeout TO '8s';

  v_cutoff := now() - interval '48 hours';
  RAISE NOTICE 'Testing proposed D-624 fix — placed_at>=% (48h cutoff)', v_cutoff;

  -- §1 — Timing of FIXED probe (with placed_at filter)
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT bet_id, user_id, placed_at, sport, is_matched
        FROM public.real_money_bets
       WHERE placed_at >= v_cutoff
       ORDER BY placed_at DESC, bet_id DESC
       LIMIT 1
    LOOP
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[1] FIXED PROBE OK: bet_id=% placed=% sport=% matched=% (% ms)',
        r.bet_id, r.placed_at, r.sport, r.is_matched, v_ms;
    END LOOP;
    IF NOT FOUND THEN
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[1] FIXED PROBE returned 0 rows (% ms) — no bets in last 48h', v_ms;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[1] FIXED PROBE ERROR: SQLSTATE=% MSG=% (% ms)', SQLSTATE, SQLERRM, v_ms;
  END;

  -- §2 — EXPLAIN of the FIXED probe
  RAISE NOTICE '';
  RAISE NOTICE '[2] EXPLAIN of FIXED probe:';
  FOR r IN
    EXPLAIN (FORMAT TEXT)
    SELECT bet_id, user_id, placed_at, sport, is_matched
      FROM public.real_money_bets
     WHERE placed_at >= v_cutoff
     ORDER BY placed_at DESC, bet_id DESC
     LIMIT 1
  LOOP
    RAISE NOTICE '  %', r."QUERY PLAN";
  END LOOP;

  -- §3 — Verify the FIXED probe still meaningfully tests the view
  -- (count rows in last 48h — if any, the view CTEs actually executed)
  RAISE NOTICE '';
  v_start := clock_timestamp();
  FOR r IN
    SELECT count(*) AS n
      FROM public.real_money_bets
     WHERE placed_at >= v_cutoff
  LOOP
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[3] real_money_bets rows in last 48h: % (count took % ms)', r.n, v_ms;
  END LOOP;

  -- §4 — Audit fetchAlgoPicks_mlb probe — does it also timeout?
  -- The probe is:
  --   GET /rest/v1/pick_history?sport=eq.mlb&recommendation_shown=eq.true
  --     &voided=eq.false&hit=not.is.null
  --     &select=id,game_date,hit,odds,prop_type,pick_side
  --     &order=game_date.asc,id.asc&limit=1
  RAISE NOTICE '';
  v_start := clock_timestamp();
  BEGIN
    FOR r IN
      SELECT id, game_date, hit, odds, prop_type, pick_side
        FROM public.pick_history
       WHERE sport = 'mlb'
         AND recommendation_shown = true
         AND voided = false
         AND hit IS NOT NULL
       ORDER BY game_date ASC, id ASC
       LIMIT 1
    LOOP
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[4] fetchAlgoPicks_mlb probe OK: id=% game_date=% (% ms)',
        r.id, r.game_date, v_ms;
    END LOOP;
    IF NOT FOUND THEN
      v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
      RAISE NOTICE '[4] fetchAlgoPicks_mlb probe 0 rows (% ms)', v_ms;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ms := 1000 * EXTRACT(EPOCH FROM (clock_timestamp() - v_start));
    RAISE NOTICE '[4] fetchAlgoPicks_mlb probe ERROR: SQLSTATE=% MSG=% (% ms)', SQLSTATE, SQLERRM, v_ms;
  END;
END $$;
