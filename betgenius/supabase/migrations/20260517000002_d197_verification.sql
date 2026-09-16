-- D-197 paired §1.12 verification migration for 20260517000001_d197_rescore_perf_indexes.sql.
-- Documents the post-deploy queries used to confirm the indexes are in place + functional.
-- Kept on disk per D-138 discipline (never delete probe migrations).
--
-- Query 1: confirm both indexes exist post-apply.
DO $$
DECLARE
  cgs_count INT;
  cods_count INT;
BEGIN
  SELECT COUNT(*) INTO cgs_count FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_cgs_lookup_by_team';
  SELECT COUNT(*) INTO cods_count FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_cods_team_date_desc';
  IF cgs_count = 0 THEN
    RAISE NOTICE 'D-197 VERIFY: idx_cgs_lookup_by_team MISSING';
  ELSE
    RAISE NOTICE 'D-197 VERIFY: idx_cgs_lookup_by_team OK';
  END IF;
  IF cods_count = 0 THEN
    RAISE NOTICE 'D-197 VERIFY: idx_cods_team_date_desc MISSING';
  ELSE
    RAISE NOTICE 'D-197 VERIFY: idx_cods_team_date_desc OK';
  END IF;
END $$;

-- Query 2 (post-deploy, run manually): EXPLAIN ANALYZE the scoreboard
-- lookup pattern to confirm index hit:
--
--   EXPLAIN ANALYZE
--   SELECT home_team, away_team
--   FROM public.cache_game_scoreboard
--   WHERE game_date = '2024-11-15'
--     AND sport = 'nba'
--     AND (home_team = 'Los Angeles Lakers' OR away_team = 'Los Angeles Lakers')
--   LIMIT 1;
--
-- Expected: `Index Scan using idx_cgs_lookup_by_team` (or bitmap OR). Pre-D-197
-- this would seq-scan or fall back to idx_cgs_date with row-filter.

-- Query 3 (post-deploy, run manually): smoke-test a single-date rescore
-- invocation against 2024-11-15 (D-194 confirmed 12 scoreboard rows for
-- that date) and measure wall-clock + per-pick latency. Target: <1s/pick;
-- escalation threshold: >2s/pick = different bottleneck than indexes.
--
--   curl -sS -X POST "https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-backfill-picks" \
--     -H "Authorization: Bearer $BACKFILL_AUTH_TOKEN" \
--     -H "Content-Type: application/json" \
--     -d '{"startDate":"2024-11-15","endDate":"2024-11-15","dryRun":true}'
--
-- Expected response.wall_clock_ms < (summary.total * 1000); ideally
-- < (summary.total * 500). Pre-D-197 would IDLE_TIMEOUT at 150s.

-- Query 4 (post-deploy): confirm no error_log entries from rescore path
-- post-apply, indicating the indexes didn't break any consumer.
--
--   SELECT COUNT(*) FROM public.error_log
--   WHERE function_name = 'rescore-backfill-picks'
--     AND created_at > NOW() - INTERVAL '30 minutes';
--
-- Expected: 0.
