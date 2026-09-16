-- D-607 SHIP 2 — partial covering index for fetch30d
-- (Performance.tsx:1312-1326 sanity-stats query).
--
-- Live state (D-607 SHIP 1 EXPLAIN against the 129K-row corpus, HOT cache):
--   sport=mlb: 25.9 ms  (BitmapAnd over 3 indexes + Bitmap Heap Scan, 1,670 heap blocks)
--   sport=nba: 92.4 ms  (BitmapAnd + Heap Scan, 99 heap blocks, 71 cold buffer reads)
-- D-604 cold-cache baseline: 2,882 ms (read=971 buffers from disk).
--
-- The query:
--   SELECT hit, coin_flip_flag, negative_stacking_flag, unbettable_juice_flag,
--          is_secondary_market, is_d214_quarantined
--     FROM pick_history
--    WHERE sport=$1 AND confidence >= 80 AND is_synthetic = false
--      AND source = $2 AND created_at >= (now() - interval '30 days')
--      AND voided = false
--    LIMIT 10000;
--
-- Fix: partial covering index keyed on (sport, source, created_at DESC) with
-- the static predicates baked in (is_synthetic=false AND voided=false AND
-- confidence>=80). INCLUDE the 6 boolean SELECT columns so PG can do Index
-- Only Scan and skip heap fetches entirely.
--
-- Predicate `confidence >= 80` in the partial index keeps it tiny — only
-- ~3,500 rows match conf>=80 across both sports (~5% of pick_history). Plus
-- voided=false + is_synthetic=false trims further.
--
-- Mirrors D-521 / D-522 / D-605 covering-partial-index pattern.

CREATE INDEX IF NOT EXISTS idx_ph_perf_sanity_30d
ON public.pick_history (sport, source, created_at DESC)
INCLUDE (hit, coin_flip_flag, negative_stacking_flag, unbettable_juice_flag,
         is_secondary_market, is_d214_quarantined)
WHERE is_synthetic = false
  AND voided = false
  AND confidence >= 80;

-- Refresh planner stats so the new index is picked up immediately.
ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-607 SHIP 3 verify — fetch30d <200ms post-fix';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Size + row count
  FOR r IN
    SELECT pg_size_pretty(pg_relation_size('public.idx_ph_perf_sanity_30d')) AS sz,
           (SELECT count(*) FROM public.pick_history
             WHERE is_synthetic = false AND voided = false AND confidence >= 80) AS rows_indexed
  LOOP RAISE NOTICE '  idx_size=% rows_indexed=%', r.sz, r.rows_indexed; END LOOP;

  -- §D.1 fetch30d MLB
  RAISE NOTICE '';
  RAISE NOTICE '[POST D.1] EXPLAIN fetch30d sport=mlb (LIMIT 10000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT hit, coin_flip_flag, negative_stacking_flag,
           unbettable_juice_flag, is_secondary_market, is_d214_quarantined
      FROM public.pick_history
     WHERE sport = 'mlb'
       AND confidence >= 80
       AND is_synthetic = false
       AND source = 'process-games-mlb'
       AND created_at >= (now() - interval '30 days')
       AND voided = false
     LIMIT 10000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §D.2 fetch30d NBA
  RAISE NOTICE '';
  RAISE NOTICE '[POST D.2] EXPLAIN fetch30d sport=nba (LIMIT 10000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT hit, coin_flip_flag, negative_stacking_flag,
           unbettable_juice_flag, is_secondary_market, is_d214_quarantined
      FROM public.pick_history
     WHERE sport = 'nba'
       AND confidence >= 80
       AND is_synthetic = false
       AND source = 'process-games'
       AND created_at >= (now() - interval '30 days')
       AND voided = false
     LIMIT 10000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: both EXPLAINs use Index Only Scan via';
  RAISE NOTICE 'idx_ph_perf_sanity_30d AND Execution Time < 200 ms.';
END $$;
