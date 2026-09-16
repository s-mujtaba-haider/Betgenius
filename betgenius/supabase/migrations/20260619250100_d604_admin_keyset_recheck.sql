-- D-604 follow-up — re-EXPLAIN the Admin panel D-602 keyset query +
-- the loadAll naked count, to confirm those didn't regress and the
-- failing query on Admin Performance is something else (the SystemHealth
-- algorithm_weights load, the cron status fetches, etc.).
--
-- Also EXPLAIN the OTHER known Admin queries fired in loadAll() so we
-- have a complete picture.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-604 follow-up — Admin queries re-EXPLAIN';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Admin panel D-602 keyset page 0 (DESC order, partial index)
  RAISE NOTICE '[F.1] Admin panel keyset page 0 (LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.pick_history
     WHERE voided IS NOT TRUE AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
     ORDER BY game_date DESC, created_at DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- loadAll headCount: pick_history naked count
  RAISE NOTICE '';
  RAISE NOTICE '[F.2] loadAll pick_history naked HEAD COUNT (Prefer count=exact):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*) FROM public.pick_history
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- loadAll: bets / recommendations_cache / props_cache / error_log / run_log counts
  RAISE NOTICE '';
  RAISE NOTICE '[F.3] loadAll counts on other tables:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*) FROM public.recommendations_cache
  $q$ LOOP RAISE NOTICE '  recommendations_cache: %', r."QUERY PLAN"; END LOOP;

  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*) FROM public.props_cache
  $q$ LOOP RAISE NOTICE '  props_cache: %', r."QUERY PLAN"; END LOOP;

  -- algorithm_weights single-row load
  RAISE NOTICE '';
  RAISE NOTICE '[F.4] loadAll algorithm_weights single-row select:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.algorithm_weights ORDER BY updated_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- Also: cumulative scenario — fetchAlgoPicks LOOP-CUMULATIVE estimate
  RAISE NOTICE '';
  RAISE NOTICE '[F.5] fetchAlgoPicks SUM of full loop (10 pages × OFFSET):';
  RAISE NOTICE '  Per-page deep-OFFSET stays ~700-5,000ms.';
  RAISE NOTICE '  Algo subset n=9,864 → loop runs 10 pages of 1000 each.';
  RAISE NOTICE '  Cumulative wall-clock = sum of per-page Execution Time.';

  RAISE NOTICE '';
  RAISE NOTICE 'D-604 follow-up complete.';
END $$;
