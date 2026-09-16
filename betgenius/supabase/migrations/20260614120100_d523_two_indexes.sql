-- D-523 SHIP 2 — Close the last two known 57014-class exposures.
-- Both index-only; no companion code change.
--
-- Predicates verified from source (D-523 SHIP 1) — match the proposed
-- shapes from D-522 SHIP 3 §F.2 and §F.4 byte-for-byte.
--
-- Pre-fix EXPLAIN ANALYZE (D-523 SHIP 1 §A.1, §A.3):
--   Games.tsx:313 mlb 60d:  15,429 ms  (was 12,476 ms in D-522 — over
--                                       8 s authenticated timeout;
--                                       actively firing 57014)
--   Admin.tsx:1965:         10,017 ms  (was 7,446 ms in D-522 — also
--                                       over 8 s; tipping intermittently)
--
-- Row counts:
--   spread_resolved (matches partial WHERE):    112 rows  (tiny index)
--   resolved_at (matches partial WHERE):    108,529 rows  (~3 MB index)
--
-- Same partial-covering pattern as D-506 idx_ph_unresolved_recent,
-- D-521 idx_ph_perf_panel, and D-522 idx_ph_algo_shown_resolved.

-- §B.1 — Games.tsx:313 spread-ATS lookback
-- Query: WHERE prop_type='spread' AND sport=$1 AND voided=false
--          AND hit IS NOT NULL AND game_date >= since
--        ORDER BY game_date DESC LIMIT 1000
-- Index keyed (sport, game_date DESC) so Index Cond lands the sport
-- partition, walks DESC for ORDER BY with no Sort step. game_date >=
-- range condition becomes a startup-bound on the same scan.
CREATE INDEX IF NOT EXISTS idx_ph_spread_resolved
ON public.pick_history (sport, game_date DESC)
WHERE prop_type = 'spread'
  AND voided = false
  AND hit IS NOT NULL;

-- §B.2 — Admin.tsx:1965 most-recent resolved_at sentinel
-- Query: WHERE resolved_at IS NOT NULL
--        ORDER BY resolved_at DESC LIMIT 1
-- Single-column partial; Index Scan LIMIT 1 = constant time.
CREATE INDEX IF NOT EXISTS idx_ph_resolved_at
ON public.pick_history (resolved_at DESC)
WHERE resolved_at IS NOT NULL;

ANALYZE public.pick_history;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-523 §C] post-create index sizes:';
  FOR r IN
    SELECT
      pg_size_pretty(pg_relation_size('public.idx_ph_spread_resolved')) AS spread_idx_size,
      pg_size_pretty(pg_relation_size('public.idx_ph_resolved_at'))     AS resolved_idx_size
  LOOP RAISE NOTICE '  spread_resolved=% resolved_at=%', r.spread_idx_size, r.resolved_idx_size; END LOOP;
END $$;

-- §D — Re-EXPLAIN AFTER for both queries (variance-controlled comparison)
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-523 §D.1] AFTER Games.tsx:313 spread-ATS (mlb 60d):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT team, opponent, pick_side, hit, game_date
    FROM public.pick_history
    WHERE prop_type='spread' AND sport='mlb' AND voided=false AND hit IS NOT NULL
      AND game_date >= '2026-04-15'::date
    ORDER BY game_date DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-523 §D.2] AFTER Games.tsx:313 spread-ATS (nba 60d):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT team, opponent, pick_side, hit, game_date
    FROM public.pick_history
    WHERE prop_type='spread' AND sport='nba' AND voided=false AND hit IS NOT NULL
      AND game_date >= '2026-04-15'::date
    ORDER BY game_date DESC LIMIT 1000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  RAISE NOTICE '[D-523 §D.3] AFTER Admin.tsx:1965 most-recent resolved_at:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT resolved_at FROM public.pick_history
    WHERE resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;
