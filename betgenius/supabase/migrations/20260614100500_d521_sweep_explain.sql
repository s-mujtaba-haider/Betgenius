-- D-521 SHIP 3 — Sweep: EXPLAIN ANALYZE the other heavy pick_history reads
-- to check for 57014 exposure on the same class of query.
DO $$
DECLARE r RECORD; v_cutoff text := (now() - interval '30 days')::text;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §H.1 — Performance.tsx:1245 (30d elite count) main read
  -- pick_history?sport=eq.mlb&confidence=gte.80&is_synthetic=eq.false
  --             &source=eq.process-games-mlb&created_at=gte.30d-ago&voided=eq.false
  RAISE NOTICE '[D-521 §H.1] Performance.tsx:1245 30d elite read (page 0-9999):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT hit, coin_flip_flag, negative_stacking_flag, unbettable_juice_flag,
           is_secondary_market, is_d214_quarantined
    FROM public.pick_history
    WHERE sport='mlb' AND confidence>=80 AND is_synthetic=false
      AND source='process-games-mlb' AND created_at >= %L::timestamptz
      AND voided=false
    LIMIT 10000
  $q$, v_cutoff)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §H.2 — same query with the count=exact aggregate
  RAISE NOTICE '[D-521 §H.2] Performance.tsx:1245 PREFER count=exact aggregate:';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*)
    FROM public.pick_history
    WHERE sport='mlb' AND confidence>=80 AND is_synthetic=false
      AND source='process-games-mlb' AND created_at >= %L::timestamptz
      AND voided=false
  $q$, v_cutoff)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §H.3 — Performance.tsx:452 algo picks paged (no count=exact already)
  -- pick_history?sport=eq.mlb&recommendation_shown=eq.true&voided=eq.false
  --             &hit=not.is.null&order=game_date.asc — page 1
  RAISE NOTICE '[D-521 §H.3] Performance.tsx:452 algo picks page 1:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date, hit, odds, prop_type, pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false
      AND hit IS NOT NULL
    ORDER BY game_date ASC
    LIMIT 1000
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
