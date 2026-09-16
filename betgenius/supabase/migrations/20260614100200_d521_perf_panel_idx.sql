-- D-521 SHIP 2a — Partial covering index for Admin Performance panel query.
--
-- The panel runs (Admin.tsx:329):
--   GET /rest/v1/pick_history?voided=not.eq.true
--                            &is_synthetic=eq.false
--                            &or=(is_d214_quarantined.is.null,is_d214_quarantined.eq.false)
--                            &game_date=not.is.null
--                            &order=game_date.desc,created_at.desc
--
-- PostgREST translates this to:
--   SELECT * FROM pick_history
--   WHERE voided IS NOT TRUE
--     AND is_synthetic = false
--     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
--     AND game_date IS NOT NULL
--   ORDER BY game_date DESC, created_at DESC
--   LIMIT N OFFSET M
--
-- Pre-fix EXPLAIN ANALYZE (D-521 SHIP 1 §C.1):
--   LIMIT 1000 → 1855 ms (backward index scan on idx_pick_history_game_date
--                         + Incremental Sort spilling 2 MB to disk)
--
-- Pre-fix EXPLAIN ANALYZE (D-521 SHIP 1 §C.2):
--   COUNT(*) → 7170 ms (Bitmap Heap Scan over 44,084 rows + filter recheck)
--
-- Fix: partial index keyed (game_date DESC, created_at DESC) with the
-- panel's exact WHERE predicate. Planner can:
--   1) Walk the index in order (no sort) for ORDER BY
--   2) Index-only scan for COUNT(*) since all index entries satisfy predicate
--
-- Mirrors D-506's idx_ph_unresolved_recent approach: partial index with
-- predicate baked in to keep the index small and the query plan flat.
CREATE INDEX IF NOT EXISTS idx_ph_perf_panel
ON public.pick_history (game_date DESC, created_at DESC)
WHERE voided IS NOT TRUE
  AND is_synthetic = false
  AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false);

-- Refresh planner stats so the new index is picked up immediately.
ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-521 §D] post-create index size + row count for idx_ph_perf_panel:';
  FOR r IN
    SELECT
      pg_size_pretty(pg_relation_size('public.idx_ph_perf_panel')) AS idx_size,
      (SELECT count(*) FROM public.pick_history
        WHERE voided IS NOT TRUE
          AND is_synthetic = false
          AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)) AS panel_rows
  LOOP RAISE NOTICE '  idx_size=% rows_indexed=%', r.idx_size, r.panel_rows; END LOOP;
END $$;

-- Re-EXPLAIN both panel queries (page + count) with the new index in place.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-521 §E.1] POST-INDEX EXPLAIN ANALYZE — first-page panel query (LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
    FROM public.pick_history
    WHERE voided IS NOT TRUE
      AND is_synthetic = false
      AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
      AND game_date IS NOT NULL
    ORDER BY game_date DESC, created_at DESC
    LIMIT 1000
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-521 §E.2] POST-INDEX EXPLAIN ANALYZE — COUNT(*) (Prefer: count=exact):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*)
    FROM public.pick_history
    WHERE voided IS NOT TRUE
      AND is_synthetic = false
      AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
      AND game_date IS NOT NULL
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-521 §E.3] POST-INDEX EXPLAIN ANALYZE — deep page (OFFSET 40000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
    FROM public.pick_history
    WHERE voided IS NOT TRUE
      AND is_synthetic = false
      AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
      AND game_date IS NOT NULL
    ORDER BY game_date DESC, created_at DESC
    OFFSET 40000 LIMIT 1000
  $q$
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
