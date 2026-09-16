-- D-521 SHIP 1 — Diagnose Admin Performance panel statement-timeout (PG 57014).
-- The panel runs Admin.tsx:329 fetch against PostgREST:
--   GET /rest/v1/pick_history?voided=not.eq.true
--                            &is_synthetic=eq.false
--                            &or=(is_d214_quarantined.is.null,is_d214_quarantined.eq.false)
--                            &game_date=not.is.null
--                            &order=game_date.desc,created_at.desc
--   Range: 0-999 (paginated 1000 at a time, up to 50 pages = 50K rows)
--   Prefer: count=exact   ← forces full-table count, separate from row pull
--
-- This diagnoses where the time is spent.
-- READ-ONLY. No DDL.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- §A — Table size + simple counts
  RAISE NOTICE '[D-521 §A] pick_history table size + matching-row counts:';
  FOR r IN
    SELECT
      pg_size_pretty(pg_total_relation_size('public.pick_history')) AS total_size,
      pg_size_pretty(pg_relation_size('public.pick_history')) AS heap_size,
      (SELECT count(*) FROM public.pick_history) AS total_rows,
      (SELECT count(*) FROM public.pick_history WHERE voided IS NOT TRUE) AS not_voided,
      (SELECT count(*) FROM public.pick_history
        WHERE voided IS NOT TRUE AND is_synthetic = false
          AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
          AND game_date IS NOT NULL) AS panel_eligible
  LOOP RAISE NOTICE '  total_size=% heap_size=% total_rows=% not_voided=% panel_eligible=%',
    r.total_size, r.heap_size, r.total_rows, r.not_voided, r.panel_eligible; END LOOP;

  -- §B — Existing indexes
  RAISE NOTICE '[D-521 §B] indexes on pick_history:';
  FOR r IN
    SELECT indexname, indexdef
    FROM pg_indexes WHERE schemaname='public' AND tablename='pick_history'
    ORDER BY indexname
  LOOP RAISE NOTICE '  %', r.indexname || ' :: ' || r.indexdef; END LOOP;
END $$;

-- §C — EXPLAIN ANALYZE the exact panel query (just the first page; this is
-- what determines whether the panel can even load its first 1000 rows).
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM public.pick_history
WHERE voided IS NOT TRUE
  AND is_synthetic = false
  AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
  AND game_date IS NOT NULL
ORDER BY game_date DESC, created_at DESC
LIMIT 1000;

-- §D — and the COUNT (Prefer: count=exact) which PostgREST runs separately.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM public.pick_history
WHERE voided IS NOT TRUE
  AND is_synthetic = false
  AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
  AND game_date IS NOT NULL;
