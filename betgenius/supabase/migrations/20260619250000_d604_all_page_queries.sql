-- D-604 — EXPLAIN ANALYZE every query that Performance.tsx + Admin
-- Performance/System Health fires, against the live 129K-row pick_history
-- corpus. D-602 fixed ONE query (Admin Performance keyset). The user
-- reports BOTH pages still fail, so there must be another query exceeding
-- the 8s authenticated statement_timeout.
--
-- D-521/522/523 pattern: fix one, the sibling surfaces. The PRIME suspect
-- is Performance.tsx:447-469 `fetchAlgoPicks` — same OFFSET-based 50-page
-- loop pattern that D-602 fixed on Admin.tsx, but on a DIFFERENT query
-- (ORDER BY game_date ASC + different predicate). D-602 didn't touch
-- Performance.tsx.
--
-- READ-ONLY. RAISE NOTICE + EXPLAIN only.

DO $$
DECLARE
  r RECORD;
  v_total bigint;
  v_algo_subset_mlb bigint;
  v_algo_subset_nba bigint;
  v_idx_algo_exists bool;
  v_idx_panel_exists bool;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-604 — sibling-query audit. Performance + Admin Performance.';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- =================== §A — Index health ===================
  SELECT EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_ph_algo_shown_resolved')
    INTO v_idx_algo_exists;
  SELECT EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_ph_perf_panel')
    INTO v_idx_panel_exists;

  RAISE NOTICE '[A] idx_ph_perf_panel (D-521 / D-602)  exists: %', v_idx_panel_exists;
  RAISE NOTICE '[A] idx_ph_algo_shown_resolved (D-522) exists: %', v_idx_algo_exists;

  IF v_idx_algo_exists THEN
    FOR r IN
      SELECT pg_size_pretty(pg_relation_size('public.idx_ph_algo_shown_resolved')) AS sz,
             indexdef
        FROM pg_indexes
       WHERE schemaname='public' AND indexname='idx_ph_algo_shown_resolved'
    LOOP RAISE NOTICE '  algo: idx_size=% def=%', r.sz, r.indexdef; END LOOP;
    FOR r IN
      SELECT idx_scan, idx_tup_read, idx_tup_fetch
        FROM pg_stat_user_indexes
       WHERE schemaname='public' AND indexrelname='idx_ph_algo_shown_resolved'
    LOOP RAISE NOTICE '  algo: pg_stat scans=% tup_read=% tup_fetch=%',
      r.idx_scan, r.idx_tup_read, r.idx_tup_fetch; END LOOP;
  END IF;

  -- =================== §B — Population sizes ===================
  SELECT count(*) INTO v_total FROM public.pick_history;
  SELECT count(*) INTO v_algo_subset_mlb FROM public.pick_history
   WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL;
  SELECT count(*) INTO v_algo_subset_nba FROM public.pick_history
   WHERE sport='nba' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL;

  RAISE NOTICE '';
  RAISE NOTICE '[B] pick_history populations:';
  RAISE NOTICE '    total=%', v_total;
  RAISE NOTICE '    algo-subset (recommendation_shown+resolved+!voided):';
  RAISE NOTICE '      sport=mlb: %  (D-522 baseline 9,344 → grew %.1fx)',
    v_algo_subset_mlb, (v_algo_subset_mlb::numeric / 9344.0);
  RAISE NOTICE '      sport=nba: %  (D-522 baseline 920 → grew %.1fx)',
    v_algo_subset_nba, (v_algo_subset_nba::numeric / 920.0);

  -- =================== §C.1 — fetchTonight (Performance.tsx:433) ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.1] EXPLAIN fetchTonight (sport=mlb today LIMIT 12):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.pick_history
     WHERE sport='mlb' AND game_date='2026-06-19'
       AND voided IS NOT TRUE AND hit IS NULL
       AND recommendation_shown = true
     ORDER BY confidence DESC LIMIT 12
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.2 — fetchAlgoPicks page 0 (Performance.tsx:452) ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.2] EXPLAIN fetchAlgoPicks page 0 (sport=mlb LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
     ORDER BY game_date ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.3 — fetchAlgoPicks deep page (the suspect) ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.3] EXPLAIN fetchAlgoPicks DEEP page (OFFSET 20000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
     ORDER BY game_date ASC OFFSET 20000 LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.4 — fetchAlgoPicks deepest tail ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.4] EXPLAIN fetchAlgoPicks DEEPEST page (OFFSET 40000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
     ORDER BY game_date ASC OFFSET 40000 LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.5 — fetch30d (Performance.tsx:1272) ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.5] EXPLAIN fetch30d (conf>=80 + cutoff 30d, Range 0-9999):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT hit,coin_flip_flag,negative_stacking_flag,unbettable_juice_flag,is_secondary_market,is_d214_quarantined
      FROM public.pick_history
     WHERE sport='mlb' AND confidence >= 80 AND is_synthetic = false
       AND source = 'process-games-mlb'
       AND created_at >= (now() - interval '30 days')
       AND voided = false
     LIMIT 10000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.6 — Admin panel D-602 keyset re-confirm ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.6] EXPLAIN Admin panel D-602 keyset page 0 (LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.pick_history
     WHERE voided IS NOT TRUE AND is_synthetic = false
       AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
       AND game_date IS NOT NULL
     ORDER BY game_date DESC, created_at DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §C.7 — Admin loadAll naked HEAD (D-601 already verified fast) ===================
  RAISE NOTICE '';
  RAISE NOTICE '[C.7] EXPLAIN Admin loadAll naked HEAD COUNT (was 205ms in D-601):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT count(*) FROM public.pick_history
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- =================== §D — Verdict template ===================
  RAISE NOTICE '';
  RAISE NOTICE '── VERDICT decision ──';
  RAISE NOTICE 'Any §C row showing Execution Time > 8000 ms is the smoking gun.';
  RAISE NOTICE 'D-602 fixed ONLY §C.6 (Admin panel). §C.2-C.4 = Performance.tsx';
  RAISE NOTICE '  fetchAlgoPicks — the prime suspect for both-pages-still-fail.';
  RAISE NOTICE 'If §C.4 > 8s → SAME D-602-class fix applies on Performance.tsx';
  RAISE NOTICE '  (keyset pagination via (sport, game_date ASC) + cursor).';

  RAISE NOTICE '';
  RAISE NOTICE 'D-604 diagnostic complete.';
END $$;
