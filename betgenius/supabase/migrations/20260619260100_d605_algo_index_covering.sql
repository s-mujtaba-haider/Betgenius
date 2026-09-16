-- D-605 — hit the <200 ms target by upgrading idx_ph_algo_shown_resolved
-- to a covering index (INCLUDE the SELECT columns + id tie-breaker).
--
-- D-605 SHIP 4 verify probe measured the bare keyset at 527-554 ms per
-- page. Plan: Index Scan + Heap Fetches (~1,069 buffers) because the
-- index keys (sport, game_date) don't cover the SELECT list, so every
-- index tuple visits the heap for visibility + payload.
--
-- Fix: add INCLUDE (id, hit, odds, prop_type, pick_side) so PG can do
-- an Index Only Scan. After autovacuum runs the visibility map, heap
-- fetches drop to ~0 and per-page execution falls below 200 ms.
--
-- Approach: build the covering index alongside the existing one, then
-- drop the old. CONCURRENTLY to avoid locking the writeable table.
-- (Cannot run CONCURRENTLY inside a transaction → use plain CREATE here
-- since Supabase migrations wrap in tx; the algo subset is only ~10K
-- rows so the lock window is ms-scale, and writes to this table happen
-- on the cron schedule which has minute-scale gaps.)

-- Drop the old index so the planner can't get confused choosing
-- between two indexes with overlapping predicates.
DROP INDEX IF EXISTS public.idx_ph_algo_shown_resolved;

CREATE INDEX idx_ph_algo_shown_resolved
ON public.pick_history (sport, game_date ASC, id ASC)
INCLUDE (hit, odds, prop_type, pick_side)
WHERE recommendation_shown = true
  AND voided = false
  AND hit IS NOT NULL;

-- Refresh planner stats so the new index is picked up immediately.
ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
  v_mid_cd date;
  v_mid_id uuid;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-605 — covering index installed; re-verify <200 ms target';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Re-EXPLAIN page 0
  RAISE NOTICE '';
  RAISE NOTICE '[POST] fetchAlgoPicks page 0 (LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- Re-EXPLAIN deep keyset
  SELECT game_date, id INTO v_mid_cd, v_mid_id
    FROM public.pick_history
   WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
   ORDER BY game_date ASC, id ASC OFFSET 8000 LIMIT 1;

  RAISE NOTICE '';
  RAISE NOTICE '[POST] fetchAlgoPicks DEEP keyset cursor=row 8000:';
  FOR r IN EXECUTE format($q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_date, hit, odds, prop_type, pick_side
      FROM public.pick_history
     WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
       AND game_date >= %L
       AND (game_date > %L OR id > %L)
     ORDER BY game_date ASC, id ASC LIMIT 1000
  $q$, v_mid_cd, v_mid_cd, v_mid_id)
  LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
