-- D-522 SHIP 2 — Partial covering index for Performance.tsx:452 algo-picks loop.
--
-- Query (Performance.tsx:452):
--   SELECT game_date,hit,odds,prop_type,pick_side FROM pick_history
--   WHERE sport=$1 AND recommendation_shown=true AND voided=false
--     AND hit IS NOT NULL
--   ORDER BY game_date ASC LIMIT N OFFSET M
--
-- Pre-fix EXPLAIN (D-522 SHIP 1):
--   §C.1 sport=mlb LIMIT 1000: 2843 ms
--        (Index Scan on idx_pick_history_game_date with 97% filter rate —
--         35,294 of 36,294 scanned rows removed by Filter)
--   §C.2 sport=mlb OFFSET 4000: 996 ms
--   §C.3 sport=nba LIMIT 1000: 247 ms (small set; uses idx_pick_history_sport_date)
--
-- Matching rows: MLB=9,344, NBA=920 (10,264 total).
--
-- Fix: partial index on (sport, game_date ASC) with the predicate baked
-- in. Same approach as D-521's idx_ph_perf_panel and D-506's
-- idx_ph_unresolved_recent. Order is sport-then-date so the planner can
-- jump to the sport partition with Index Cond, then walk in ASC order
-- for ORDER BY with no Sort step.
--
-- No Prefer: count=exact in the fetch (confirmed at Performance.tsx:455),
-- so this fix is index-only — no companion code change needed.
CREATE INDEX IF NOT EXISTS idx_ph_algo_shown_resolved
ON public.pick_history (sport, game_date ASC)
WHERE recommendation_shown = true
  AND voided = false
  AND hit IS NOT NULL;

ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-522 §D] post-create idx size + indexed-row count:';
  FOR r IN
    SELECT
      pg_size_pretty(pg_relation_size('public.idx_ph_algo_shown_resolved')) AS idx_size,
      (SELECT count(*) FROM public.pick_history
        WHERE recommendation_shown = true
          AND voided = false
          AND hit IS NOT NULL) AS rows_indexed
  LOOP RAISE NOTICE '  idx_size=% rows_indexed=%', r.idx_size, r.rows_indexed; END LOOP;
END $$;

-- Re-EXPLAIN both per-sport pages.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-522 §E.1] POST-INDEX page 1 (sport=mlb LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-522 §E.2] POST-INDEX deep page (sport=mlb OFFSET 4000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC OFFSET 4000 LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-522 §E.3] POST-INDEX page 1 (sport=nba LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='nba' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-522 §E.4] POST-INDEX deepest mlb page (OFFSET 9000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC OFFSET 9000 LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
