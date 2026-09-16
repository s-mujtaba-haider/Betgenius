-- D-506 SHIP 2a — partial index matching the resolve-picks picks-query predicate.
--
-- ROOT CAUSE: the picks query uses `ORDER BY created_at.asc LIMIT 200` and the
-- planner chooses a backward index scan on idx_pick_history_created (DESC).
-- It then must Filter out rows where (hit IS NOT NULL OR resolved_at IS NOT NULL
-- OR voided OR game_date < cutoff) — currently 84,379 rows skipped per call.
-- Cold-cache time: 9,461 ms. authenticator role statement_timeout: 8 s. Result:
-- PostgREST returns HTTP 500 with PG error 57014; the function's try/catch
-- treats !picksRes.ok as "no picks", logs "Found 0", returns success — 12-day
-- stall, 15,961 picks unresolved, 35 of 36 cron runs report "succeeded".
--
-- FIX: partial index containing only the unresolved+non-voided subset
-- (~16,645 rows), keyed by created_at ASC. The LIMIT 200 scan now reads
-- at most 200 index entries from a tiny B-tree. Cold-cache projected <50 ms.
--
-- Predicate matches PostgREST's `hit=is.null&resolved_at=is.null&voided=neq.true`:
--   - `hit IS NULL` exact match
--   - `resolved_at IS NULL` exact match
--   - `NOT voided` matches `voided <> true` (3-valued: NULL excluded from index;
--     stalled picks have voided=false so they ARE included)
-- The planner will match this partial index for the resolve-picks SELECT and
-- any other query with the same predicate.
--
-- Rollback (if performance regresses for any reason):
--   DROP INDEX IF EXISTS public.idx_ph_unresolved_recent;
--
-- Lock window: regular CREATE INDEX takes a ShareLock on pick_history that
-- blocks INSERT/UPDATE/DELETE for the duration. 119,571 rows, ~16k indexed →
-- ~1-2 seconds. Production write rate ~1 pick/sec — acceptable brief stall.

CREATE INDEX IF NOT EXISTS idx_ph_unresolved_recent
  ON public.pick_history (created_at ASC)
  WHERE hit IS NULL AND resolved_at IS NULL AND NOT voided;

DO $$
DECLARE r RECORD; v_start TIMESTAMPTZ; v_end TIMESTAMPTZ;
BEGIN
  SET LOCAL statement_timeout TO '60s';
  -- Verify the planner picks the new index
  RAISE NOTICE '[D-506] EXPLAIN ANALYZE after partial index creation:';
  FOR r IN
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, player_name, team, prop_type, line, pick_side, game_time,
           created_at, sport, opponent, mlb_market_type, game_date, is_home
    FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
      AND game_date >= DATE '2026-05-28'
    ORDER BY created_at ASC LIMIT 200
  LOOP
    RAISE NOTICE '  %', r."QUERY PLAN";
  END LOOP;

  -- Wall-clock timing (cold cache caveat — run pulls into buffers)
  v_start := clock_timestamp();
  PERFORM id FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND game_date >= DATE '2026-05-28'
   ORDER BY created_at ASC LIMIT 200;
  v_end := clock_timestamp();
  RAISE NOTICE '[D-506] post-index SQL duration: % ms',
    extract(milliseconds from (v_end - v_start));
END $$;
