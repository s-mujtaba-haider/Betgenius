-- D-602 SHIP 3 v2 VERIFY — the v1 keyset (OR-clause) ran as Filter on
-- index walk (6.6s / 2.2s). PG can't push the OR into Index Cond on a
-- two-col index. Reframe as `game_date <= CD AND NOT (game_date = CD AND
-- created_at >= CC)` so `game_date <= CD` becomes the Index Cond seek.
--
-- Logically identical to (a,b) < (c,d) DESC walk: the seek anchors at
-- game_date=CD rows, then the NOT-AND filter excludes the rows above
-- the cursor (which are at most a few rows / one date partition).
--
-- Read-only.

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
  RAISE NOTICE 'D-602 SHIP 3 v2 — keyset via Index Cond seek (AND + NOT-AND)';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  SELECT game_date, created_at
    INTO v_mid_cd, v_mid_cc
    FROM public.pick_history
   WHERE voided IS NOT TRUE AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
   ORDER BY game_date DESC, created_at DESC
   OFFSET 20000 LIMIT 1;

  SELECT game_date, created_at
    INTO v_deep_cd, v_deep_cc
    FROM public.pick_history
   WHERE voided IS NOT TRUE AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
   ORDER BY game_date DESC, created_at DESC
   OFFSET 40000 LIMIT 1;

  RAISE NOTICE '[D-602 v2 §A] mid_cd=% mid_cc=%', v_mid_cd, v_mid_cc;
  RAISE NOTICE '[D-602 v2 §A] deep_cd=% deep_cc=%', v_deep_cd, v_deep_cc;

  RAISE NOTICE '';
  RAISE NOTICE '[D-602 v2 §B.1] EXPLAIN — keyset v2 from MID cursor:';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
      FROM public.pick_history
     WHERE voided IS NOT TRUE
       AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
       AND game_date <= %L
       AND NOT (game_date = %L AND created_at >= %L)
     ORDER BY game_date DESC, created_at DESC
     LIMIT 1000
  $q$, v_mid_cd, v_mid_cd, v_mid_cc)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[D-602 v2 §B.2] EXPLAIN — keyset v2 from DEEP cursor:';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT *
      FROM public.pick_history
     WHERE voided IS NOT TRUE
       AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
       AND game_date <= %L
       AND NOT (game_date = %L AND created_at >= %L)
     ORDER BY game_date DESC, created_at DESC
     LIMIT 1000
  $q$, v_deep_cd, v_deep_cd, v_deep_cc)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: Index Cond now includes "(game_date <= cursor)"';
  RAISE NOTICE '              and Execution Time < 500 ms (vs v1''s 6.6s/2.2s).';
END $$;
