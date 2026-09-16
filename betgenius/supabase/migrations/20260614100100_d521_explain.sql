-- D-521 SHIP 1 — Capture EXPLAIN ANALYZE output for the panel queries.
-- We wrap EXPLAIN in a DO block so its output flows through RAISE NOTICE
-- and gets captured by `supabase db push` logs.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '[D-521 §C.1] EXPLAIN ANALYZE — first-page panel query (LIMIT 1000):';
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

  RAISE NOTICE '[D-521 §C.2] EXPLAIN ANALYZE — COUNT (Prefer: count=exact):';
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

  RAISE NOTICE '[D-521 §C.3] EXPLAIN ANALYZE — deep page (OFFSET 40000 LIMIT 1000):';
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
