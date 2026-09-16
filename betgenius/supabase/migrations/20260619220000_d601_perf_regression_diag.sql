-- D-601 — READ-ONLY 57014 regression diagnostic. NO writes, NO drops.
--
-- D-521 fixed Admin Performance panel 57014 timeouts by adding partial
-- index `idx_ph_perf_panel` (game_date DESC, created_at DESC) WHERE
-- voided IS NOT TRUE AND is_synthetic=false AND quarantined-or-null.
-- The current panel query at Admin.tsx:342 is BYTE-IDENTICAL to D-521
-- baseline (confirmed by code-level diff).
--
-- Goal: name the exact cause of the recurrence. Hypotheses to rule
-- in/out:
--   H1. idx_ph_perf_panel was dropped → re-add it
--   H2. Index exists but planner stopped using it (row count grew /
--       bloat / stale stats) → re-ANALYZE or rebuild
--   H3. Index used, but partial+OFFSET deep-page exceeds 8s now that
--       table size has grown past D-521's 44K baseline
--   H4. The 57014 comes from a DIFFERENT query in Admin (not the panel),
--       e.g. the naked `pick_history?select=id` HEAD COUNT in loadAll
--       line 1982 (no WHERE, walks full heap) OR the
--       `resolved_at=not.is.null&order=resolved_at.desc&limit=1` at
--       line 2000 if there's no index on resolved_at.
--
-- This migration runs ALL of: index presence + pg_stat scan count +
-- EXPLAIN ANALYZE on (a) the panel query first-page, (b) the panel
-- query deep-page, (c) the naked HEAD COUNT, (d) the resolved_at limit-1
-- check. Surfaces results via RAISE NOTICE.
--
-- SAFE: no DDL, no DML. Pure RAISE NOTICE + EXPLAIN.

DO $$
DECLARE
  r        RECORD;
  v_total  bigint;
  v_panel  bigint;
  v_synth  bigint;
  v_resolved_at_idx bool;
  v_idx_exists bool;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-601 — Admin Performance 57014 regression diagnostic';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  --
  -- §A — Index existence + meta
  --
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_ph_perf_panel'
  ) INTO v_idx_exists;
  RAISE NOTICE '[D-601 §A] idx_ph_perf_panel exists: %', v_idx_exists;

  IF v_idx_exists THEN
    FOR r IN
      SELECT pg_size_pretty(pg_relation_size('public.idx_ph_perf_panel')) AS sz,
             indexdef
        FROM pg_indexes
       WHERE schemaname='public' AND indexname='idx_ph_perf_panel'
    LOOP
      RAISE NOTICE '  idx_size=% def=%', r.sz, r.indexdef;
    END LOOP;

    -- pg_stat: has the planner been picking it?
    FOR r IN
      SELECT idx_scan, idx_tup_read, idx_tup_fetch
        FROM pg_stat_user_indexes
       WHERE schemaname='public' AND indexrelname='idx_ph_perf_panel'
    LOOP
      RAISE NOTICE '  pg_stat: idx_scan=% idx_tup_read=% idx_tup_fetch=%',
        r.idx_scan, r.idx_tup_read, r.idx_tup_fetch;
    END LOOP;
  END IF;

  --
  -- §B — pick_history row counts (the populations the planner sees)
  --
  SELECT count(*) INTO v_total FROM public.pick_history;
  SELECT count(*) INTO v_panel
    FROM public.pick_history
   WHERE voided IS NOT TRUE
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL;
  SELECT count(*) INTO v_synth
    FROM public.pick_history WHERE is_synthetic = true;

  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §B] pick_history populations:';
  RAISE NOTICE '  total=% panel-scope=% synthetic=%', v_total, v_panel, v_synth;
  RAISE NOTICE '  (D-521 baseline: panel-scope=44,084)';

  --
  -- §C.1 — EXPLAIN ANALYZE the EXACT current panel query (page 0)
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §C.1] EXPLAIN — panel page 0 (LIMIT 1000):';
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
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  --
  -- §C.2 — EXPLAIN ANALYZE the EXACT current panel query (deep page)
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §C.2] EXPLAIN — panel deep page (OFFSET 40000 LIMIT 1000):';
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
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  --
  -- §C.3 — EXPLAIN — naked HEAD COUNT (loadAll line 1982):
  --   GET /rest/v1/pick_history?select=id   (HEAD + Prefer: count=exact)
  -- PostgREST translates count=exact to a SELECT count(*) plan.
  -- No WHERE → idx_ph_perf_panel is partial, can't satisfy; planner
  -- must walk pkey or seqscan.
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §C.3] EXPLAIN — naked HEAD COUNT (loadAll line 1982):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*) FROM public.pick_history
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  --
  -- §C.4 — EXPLAIN — resolved_at staleness check (loadAll line 2000):
  --   pick_history?select=resolved_at&resolved_at=not.is.null
  --                &order=resolved_at.desc&limit=1
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §C.4] EXPLAIN — resolved_at staleness check:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT resolved_at FROM public.pick_history
     WHERE resolved_at IS NOT NULL
     ORDER BY resolved_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- Is there an index on resolved_at?
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='pick_history'
       AND indexdef ILIKE '%resolved_at%'
  ) INTO v_resolved_at_idx;
  RAISE NOTICE '[D-601 §C.4b] index touching resolved_at exists: %', v_resolved_at_idx;

  --
  -- §D — Statement-timeout for the role(s) we hit
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D-601 §D] statement_timeout per role:';
  FOR r IN
    SELECT rolname, rolconfig
      FROM pg_roles
     WHERE rolname IN ('authenticator','postgrest','anon','authenticated')
  LOOP RAISE NOTICE '  role=% config=%', r.rolname, r.rolconfig; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-601 diagnostic complete. Read the plans above to name the cause:';
  RAISE NOTICE '  - §A=NO  → H1 (index dropped). Re-add via D-521 migration.';
  RAISE NOTICE '  - §A=YES + §C.1 uses idx_ph_perf_panel + <8s → panel NOT the cause; look at §C.3 / §C.4.';
  RAISE NOTICE '  - §A=YES + §C.1 Seq Scan → H2 (planner abandoned index). ANALYZE or REINDEX.';
  RAISE NOTICE '  - §A=YES + §C.2 >8s → H3 (panel scan slow at deep OFFSET due to growth). New strategy or higher timeout.';
  RAISE NOTICE '  - §C.3 >2-3s → H4 (loadAll naked COUNT is the 57014 source, not the panel itself).';
END $$;
