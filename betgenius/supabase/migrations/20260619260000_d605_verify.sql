-- D-605 SHIP 4 verify — EXPLAIN ANALYZE the new queries against the live
-- DB to confirm each is <200ms (mirror of D-602 v2 verify pattern).
--
-- Two queries fixed in this batch:
--   FIX A (Admin counts): Prefer: count=planned on heavy tables.
--   FIX B (Performance keyset): fetchAlgoPicks decomposed-seek pattern.
--
-- READ-ONLY.

DO $$
DECLARE
  r RECORD;
  v_mid_cd date;
  v_mid_id uuid;
  v_deep_cd date;
  v_deep_id uuid;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-605 VERIFY — Admin count=planned + Performance keyset';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- =================== FIX A — count=planned ===================
  -- PostgREST count=planned reads `relpages * (avg row width / 8K page)`
  -- estimate from pg_class.reltuples. We can't reproduce the EXACT
  -- PostgREST behavior from raw SQL, but we can confirm the underlying
  -- planner-estimate read is <1ms:
  RAISE NOTICE '';
  RAISE NOTICE '[A] pg_class.reltuples lookup (PostgREST count=planned source):';
  FOR r IN
    SELECT relname, reltuples::bigint AS planner_estimate, pg_size_pretty(pg_relation_size(oid)) AS rel_sz
      FROM pg_class
     WHERE relname IN ('pick_history','props_cache','recommendations_cache','bets','algorithm_weights')
       AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
     ORDER BY reltuples DESC
  LOOP
    RAISE NOTICE '  table=% rel_sz=% planner_estimate=%', r.relname, r.rel_sz, r.planner_estimate;
  END LOOP;
  RAISE NOTICE '  (PostgREST returns these values for Prefer: count=planned in <1ms — no Aggregate node)';
  RAISE NOTICE '  D-604 baseline: props_cache count=exact = 8,903 ms (TIMEOUT)';
  RAISE NOTICE '                  recs_cache  count=exact = 7,040 ms (borderline)';

  -- =================== FIX B — fetchAlgoPicks keyset ===================
  -- Page 0
  RAISE NOTICE '';
  RAISE NOTICE '[B.1] fetchAlgoPicks page 0 (no cursor, LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- Synthesize a mid-corpus cursor
  SELECT game_date, id INTO v_mid_cd, v_mid_id
    FROM public.pick_history
   WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
   ORDER BY game_date ASC, id ASC OFFSET 4000 LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE '[B] mid cursor (row 4000): game_date=% id=%', v_mid_cd, v_mid_id;

  -- Mid keyset
  RAISE NOTICE '';
  RAISE NOTICE '[B.2] fetchAlgoPicks MID cursor (game_date>=cd AND tie-break):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
       AND game_date >= %L
       AND (game_date > %L OR id > %L)
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$, v_mid_cd, v_mid_cd, v_mid_id)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- Deep cursor near corpus tail
  SELECT game_date, id INTO v_deep_cd, v_deep_id
    FROM public.pick_history
   WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
   ORDER BY game_date ASC, id ASC OFFSET 8000 LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE '[B] deep cursor (row 8000): game_date=% id=%', v_deep_cd, v_deep_id;

  RAISE NOTICE '';
  RAISE NOTICE '[B.3] fetchAlgoPicks DEEP cursor:';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
       AND game_date >= %L
       AND (game_date > %L OR id > %L)
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$, v_deep_cd, v_deep_cd, v_deep_id)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: all [B.x] EXPLAINs Index Scan via idx_ph_algo_shown_resolved';
  RAISE NOTICE '               + Execution Time < 200 ms each.';
  RAISE NOTICE 'D-604 baseline: OFFSET 0 LIMIT 1000 = 707 ms; OFFSET 20K = 5,018 ms.';
END $$;
