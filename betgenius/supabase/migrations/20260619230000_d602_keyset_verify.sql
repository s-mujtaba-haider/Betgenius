-- D-602 SHIP 3 VERIFY (read-only) — confirm keyset pagination uses
-- idx_ph_perf_panel + stays well under the 8s authenticated timeout
-- on deep pages, where D-601 §C.2 measured 9,819 ms for the OFFSET-based
-- equivalent query at OFFSET 40000.
--
-- The keyset filter for page N>0 (from src/pages/Admin.tsx fetchData):
--   and=(or(game_date.lt.CD,and(game_date.eq.CD,created_at.lt.CC)))
-- PostgREST translates to PG SQL:
--   AND (game_date < CD OR (game_date = CD AND created_at < CC))
-- combined with the existing top-level WHERE (voided / is_synthetic /
-- is_d214_quarantined / game_date NOT NULL).
--
-- Safe: read-only, RAISE NOTICE only.

DO $$
DECLARE
  r RECORD;
  v_mid_cd date;
  v_mid_cc timestamptz;
  v_deep_cd date;
  v_deep_cc timestamptz;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-602 SHIP 3 VERIFY — keyset pagination on idx_ph_perf_panel';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Synthesize a MID cursor at row ~20,000 of the panel-scoped corpus.
  SELECT game_date, created_at
    INTO v_mid_cd, v_mid_cc
    FROM public.pick_history
   WHERE voided IS NOT TRUE
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
   ORDER BY game_date DESC, created_at DESC
   OFFSET 20000 LIMIT 1;
  RAISE NOTICE '[D-602 §A] mid-corpus cursor (row 20000): game_date=% created_at=%', v_mid_cd, v_mid_cc;

  -- Synthesize a DEEP cursor at row ~40,000 (mirror of D-601 §C.2 OFFSET).
  SELECT game_date, created_at
    INTO v_deep_cd, v_deep_cc
    FROM public.pick_history
   WHERE voided IS NOT TRUE
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
   ORDER BY game_date DESC, created_at DESC
   OFFSET 40000 LIMIT 1;
  RAISE NOTICE '[D-602 §A] deep-corpus cursor (row 40000): game_date=% created_at=%', v_deep_cd, v_deep_cc;

  -- §B.1 — Keyset page from the MID cursor.
  RAISE NOTICE '';
  RAISE NOTICE '[D-602 §B.1] EXPLAIN — keyset from mid cursor (1000 rows, no OFFSET):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
      FROM public.pick_history
     WHERE voided IS NOT TRUE
       AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
       AND (game_date < %L
            OR (game_date = %L AND created_at < %L))
     ORDER BY game_date DESC, created_at DESC
     LIMIT 1000
  $q$, v_mid_cd, v_mid_cd, v_mid_cc)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §B.2 — Keyset page from the DEEP cursor.
  RAISE NOTICE '';
  RAISE NOTICE '[D-602 §B.2] EXPLAIN — keyset from deep cursor (1000 rows):';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
      FROM public.pick_history
     WHERE voided IS NOT TRUE
       AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
       AND (game_date < %L
            OR (game_date = %L AND created_at < %L))
     ORDER BY game_date DESC, created_at DESC
     LIMIT 1000
  $q$, v_deep_cd, v_deep_cd, v_deep_cc)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: both EXPLAINs use Index Scan via idx_ph_perf_panel';
  RAISE NOTICE '              and Execution Time < 500 ms each. D-601 §C.2 baseline';
  RAISE NOTICE '              for the equivalent OFFSET query was 9,819 ms.';
END $$;
