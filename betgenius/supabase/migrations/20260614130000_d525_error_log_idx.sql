-- D-525 — Pre-fire index on error_log before it grows past 100K rows.
--
-- Query (Admin.tsx:2004):
--   GET /rest/v1/error_log?created_at=gte.{since-7d}
--                         &select=function_name,error_type,error_message,created_at
--                         &order=created_at.desc&limit=500
--
-- Pre-fix EXPLAIN (D-523 SHIP 3 §E.4, 2026-06-14): 1,561 ms.
-- Plan: Seq Scan over 43,893 rows + top-N heapsort to keep top 500.
-- Same shape as Admin.tsx:1965 pre-D-523 — sub-2s today but trends
-- toward 57014 as error_log grows beyond ~100K rows.
--
-- Fix: plain (non-partial) btree on created_at DESC. No partial-WHERE
-- because there's no stable boolean filter to bake in — the 7-day
-- cutoff is a moving window (a partial WHERE on `created_at >= now() -
-- interval '7 days'` would require periodic REINDEX). The full index
-- gives the planner a backward scan + early-stop at the cutoff with
-- no maintenance churn.
--
-- Expected size at 100K rows: ~5 MB.
-- Mirrors the same pattern as D-521 / D-522 / D-523 (btree on the
-- ORDER BY key); just plain since the predicate is range-bounded
-- rather than boolean.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §A — BEFORE
  RAISE NOTICE '[D-525 §A] BEFORE error_log 7d top 500:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT function_name, error_type, error_message, created_at
    FROM public.error_log
    WHERE created_at >= (now() - interval '7 days')
    ORDER BY created_at DESC LIMIT 500
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_error_log_created_at
ON public.error_log (created_at DESC);

ANALYZE public.error_log;

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-525 §B] post-create index size + row count:';
  FOR r IN
    SELECT
      pg_size_pretty(pg_relation_size('public.idx_error_log_created_at')) AS idx_size,
      (SELECT count(*) FROM public.error_log) AS rows_total
  LOOP RAISE NOTICE '  idx_size=% rows_total=%', r.idx_size, r.rows_total; END LOOP;

  -- §C — AFTER
  RAISE NOTICE '[D-525 §C] AFTER error_log 7d top 500:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT function_name, error_type, error_message, created_at
    FROM public.error_log
    WHERE created_at >= (now() - interval '7 days')
    ORDER BY created_at DESC LIMIT 500
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
