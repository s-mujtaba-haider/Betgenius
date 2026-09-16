-- D-523 SHIP 1 — Re-EXPLAIN both queries fresh (same-session baseline so
-- the AFTER comparison is variance-controlled).
--
-- Predicates re-read from source (D-523 SHIP 1):
--   Games.tsx:313 — pick_history?prop_type=eq.spread&sport=eq.{sport}
--                  &voided=eq.false&hit=not.is.null
--                  &game_date=gte.{since}&order=game_date.desc&limit=1000
--   Admin.tsx:1965 — pick_history?select=resolved_at&resolved_at=not.is.null
--                   &order=resolved_at.desc&limit=1
-- Predicates match the proposed indexes exactly.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §A.1 — Games.tsx:313 BEFORE (mlb 60d)
  RAISE NOTICE '[D-523 §A.1] BEFORE Games.tsx:313 spread-ATS read (mlb 60d):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT team, opponent, pick_side, hit, game_date
    FROM public.pick_history
    WHERE prop_type='spread' AND sport='mlb' AND voided=false AND hit IS NOT NULL
      AND game_date >= '2026-04-15'::date
    ORDER BY game_date DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §A.2 — Games.tsx:313 BEFORE (nba 60d) — different sport for symmetry
  RAISE NOTICE '[D-523 §A.2] BEFORE Games.tsx:313 spread-ATS read (nba 60d):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT team, opponent, pick_side, hit, game_date
    FROM public.pick_history
    WHERE prop_type='spread' AND sport='nba' AND voided=false AND hit IS NOT NULL
      AND game_date >= '2026-04-15'::date
    ORDER BY game_date DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §A.3 — Admin.tsx:1965 BEFORE
  RAISE NOTICE '[D-523 §A.3] BEFORE Admin.tsx:1965 most-recent resolved_at:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT resolved_at FROM public.pick_history
    WHERE resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §A.4 — count matching rows for each new index
  RAISE NOTICE '[D-523 §A.4] row counts for the two new partial indexes:';
  FOR r IN
    SELECT
      (SELECT count(*) FROM public.pick_history
        WHERE prop_type='spread' AND voided=false AND hit IS NOT NULL) AS spread_resolved_rows,
      (SELECT count(*) FROM public.pick_history
        WHERE resolved_at IS NOT NULL) AS resolved_at_rows
  LOOP RAISE NOTICE '  spread_resolved=% resolved_at=%', r.spread_resolved_rows, r.resolved_at_rows; END LOOP;
END $$;
