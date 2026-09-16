-- D-607 SHIP 2 v2 — first index attempt was ignored by the planner.
-- It still chose BitmapAnd over 3 existing indexes (idx_pick_history_confidence
-- + idx_ph_mlb_beta + pick_history_production_natural_uniq) at 268 ms.
-- Plan reasoning: planner cost-estimate didn't recognize my partial index
-- as cheaper because (sport, source, created_at DESC) didn't include
-- confidence in the keys.
--
-- v2 redesign:
--   - Drop the v1 attempt
--   - Add an INDEX ONLY SCAN-friendly design where the predicate columns
--     are the seek anchors and the SELECT columns are INCLUDE'd
--   - Key columns: (sport, source, created_at DESC) — small key set
--   - Partial predicate: is_synthetic=false AND voided=false AND confidence>=80
--     (planner-checked predicate, no key needed for these — but it must match
--     the query EXACTLY for predicate equivalence)
--
-- v2 strategy: drop the existing tiny BitmapAnd indexes' usefulness for THIS
-- query by giving the planner a smaller, narrower, cheaper option that
-- avoids heap fetches entirely. The 3 BitmapAnd indexes still exist for
-- other queries; we just need OUR query to find a clearly-cheaper Index
-- Only Scan path.

DROP INDEX IF EXISTS public.idx_ph_perf_sanity_30d;

-- v2: key cols match the WHERE filter order tightly. INCLUDE covers all
-- SELECT columns. Partial predicate filters to ~2,000 indexed rows.
-- The composite key (sport, source, created_at) + smaller row count gives
-- the planner a sub-100KB index it'll choose over the multi-bitmap.
CREATE INDEX idx_ph_perf_sanity_30d
ON public.pick_history (sport, source, created_at DESC)
INCLUDE (hit, coin_flip_flag, negative_stacking_flag, unbettable_juice_flag,
         is_secondary_market, is_d214_quarantined, confidence)
WHERE is_synthetic = false
  AND voided = false
  AND confidence >= 80;

ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-607 v2 verify';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  FOR r IN
    SELECT pg_size_pretty(pg_relation_size('public.idx_ph_perf_sanity_30d')) AS sz
  LOOP RAISE NOTICE '  v2 idx_size=%', r.sz; END LOOP;

  -- §V.1 fetch30d MLB
  RAISE NOTICE '';
  RAISE NOTICE '[V.1] EXPLAIN fetch30d sport=mlb (default planner):';
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

  -- §V.2 same query with bitmap disabled to FORCE Index Only Scan + verify cost
  RAISE NOTICE '';
  RAISE NOTICE '[V.2] EXPLAIN fetch30d sport=mlb FORCED (bitmapscan=off):';
  SET LOCAL enable_bitmapscan = off;
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
END $$;
