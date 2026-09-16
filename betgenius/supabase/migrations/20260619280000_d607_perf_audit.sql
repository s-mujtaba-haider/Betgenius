-- D-607 SHIP 1 — EXPLAIN ANALYZE every Performance.tsx query against the
-- live corpus, no assumptions. Confirm fetch30d is the failure, OR find
-- the real culprit.
--
-- The full Performance.tsx live query inventory:
--   §A  fetchBets (real_money_bets, user-scoped, D-605 keyset)        — line 414/420
--   §B  fetchTonight (sport+date+limit=12)                            — line 448
--   §C  fetchAlgoPicks (D-605 keyset + covering INCLUDE)              — line 496/501
--   §D  fetch30d (Range 0-9999, source+conf+30d filter)               — line 1324
--
-- §D is the prime suspect — single-shot, never ported.
-- READ-ONLY.

DO $$
DECLARE
  r RECORD;
  v_30d_count bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-607 SHIP 1 — confirm the failing query via EXPLAIN ANALYZE';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  --
  -- §D fetch30d — the prime suspect
  --
  SELECT count(*) INTO v_30d_count FROM public.pick_history
   WHERE sport='mlb' AND confidence >= 80 AND is_synthetic = false
     AND source = 'process-games-mlb'
     AND created_at >= (now() - interval '30 days')
     AND voided = false;
  RAISE NOTICE '';
  RAISE NOTICE '[D.pop] fetch30d matching-row count: %', v_30d_count;

  RAISE NOTICE '';
  RAISE NOTICE '[D.1] EXPLAIN fetch30d (sport=mlb, the LIVE query, with select list):';
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

  RAISE NOTICE '';
  RAISE NOTICE '[D.2] EXPLAIN fetch30d (sport=nba variant):';
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

  --
  -- §B fetchTonight — sanity, expected fast
  --
  RAISE NOTICE '';
  RAISE NOTICE '[B.1] EXPLAIN fetchTonight (LIMIT 12 by confidence DESC):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.pick_history
     WHERE sport = 'mlb' AND game_date = '2026-06-19'
       AND voided IS NOT TRUE AND hit IS NULL AND recommendation_shown = true
     ORDER BY confidence DESC LIMIT 12
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  --
  -- §C fetchAlgoPicks — D-605 keyset, should be <200ms
  --
  RAISE NOTICE '';
  RAISE NOTICE '[C.1] EXPLAIN fetchAlgoPicks page 0 (D-605 covering index):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport = 'mlb' AND recommendation_shown = true
       AND voided = false AND hit IS NOT NULL
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS criteria: every query Execution Time < 8,000 ms.';
  RAISE NOTICE 'TARGET for fix: < 200 ms.';
  RAISE NOTICE 'Any "Buffers: shared read=N" indicates COLD disk reads.';
END $$;
