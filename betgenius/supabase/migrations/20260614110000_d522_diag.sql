-- D-522 SHIP 1 — Diagnose Performance.tsx:452 algo-picks loop.
-- Query (per-sport, 1000-row pages, no count=exact):
--   GET /rest/v1/pick_history?sport=eq.{sport}
--                            &recommendation_shown=eq.true
--                            &voided=eq.false
--                            &hit=not.is.null
--                            &select=game_date,hit,odds,prop_type,pick_side
--                            &order=game_date.asc
--
-- PostgREST translates to:
--   SELECT game_date,hit,odds,prop_type,pick_side FROM pick_history
--   WHERE sport=$1 AND recommendation_shown=true AND voided=false
--     AND hit IS NOT NULL
--   ORDER BY game_date ASC LIMIT N OFFSET M
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- §A — count matching rows per sport
  RAISE NOTICE '[D-522 §A] matching-row counts by sport:';
  FOR r IN
    SELECT sport, count(*) AS n,
           min(game_date)::text AS oldest, max(game_date)::text AS newest
    FROM public.pick_history
    WHERE sport IN ('mlb','nba')
      AND recommendation_shown = true
      AND voided = false
      AND hit IS NOT NULL
    GROUP BY sport ORDER BY sport
  LOOP RAISE NOTICE '  sport=% n=% oldest=% newest=%', r.sport, r.n, r.oldest, r.newest; END LOOP;

  -- §B — Indexes that touch sport/game_date already
  RAISE NOTICE '[D-522 §B] candidate indexes already on pick_history (filtered):';
  FOR r IN
    SELECT indexname, indexdef
    FROM pg_indexes WHERE schemaname='public' AND tablename='pick_history'
      AND (indexdef ILIKE '%sport%' OR indexdef ILIKE '%game_date%' OR indexdef ILIKE '%recommendation_shown%')
    ORDER BY indexname
  LOOP RAISE NOTICE '  %', r.indexname || ' :: ' || r.indexdef; END LOOP;

  -- §C.1 — EXPLAIN ANALYZE page 1 (MLB)
  RAISE NOTICE '[D-522 §C.1] EXPLAIN page 1 (sport=mlb LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §C.2 — EXPLAIN ANALYZE deep page (MLB, OFFSET 4000 LIMIT 1000)
  RAISE NOTICE '[D-522 §C.2] EXPLAIN deep page (sport=mlb OFFSET 4000 LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC OFFSET 4000 LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §C.3 — EXPLAIN ANALYZE page 1 (NBA)
  RAISE NOTICE '[D-522 §C.3] EXPLAIN page 1 (sport=nba LIMIT 1000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT game_date,hit,odds,prop_type,pick_side
    FROM public.pick_history
    WHERE sport='nba' AND recommendation_shown=true AND voided=false AND hit IS NOT NULL
    ORDER BY game_date ASC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
