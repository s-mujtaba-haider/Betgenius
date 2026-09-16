-- ============================================================================
-- Migration : 20260505000000_phase4_def_rating.sql
-- Date      : 2026-05-05
-- Purpose   : Add def_rating column to cache_opponent_defensive_stats so the
--             May 5 BDL rewire (commit da98c6c) can persist
--             OpponentStats.defensiveRating to cache. Phase 5 (analyze-pick
--             reads from cache for points/PRA/PA/PR opp signal) is gated on
--             this column existing AND being populated by a subsequent cron
--             tick.
--
-- Context   :
--   - da98c6c added BDL /v1/teamseasonaverages/advanced fetch in
--     fetchOpponentDefensiveStats. defensiveRating field on OpponentStats
--     interface gets populated in memory.
--   - Phase 3 verification (May 5) discovered the cache schema has no
--     def_rating column → writer at process-games:296-326 had no place to
--     persist it → memory-only signal.
--   - This migration adds the column. Companion writer change in same
--     deploy populates it.
--
-- Rollback  :
--     ALTER TABLE public.cache_opponent_defensive_stats DROP COLUMN IF EXISTS def_rating;
-- ============================================================================

ALTER TABLE public.cache_opponent_defensive_stats
  ADD COLUMN IF NOT EXISTS def_rating NUMERIC(5,2);

COMMENT ON COLUMN public.cache_opponent_defensive_stats.def_rating IS
  'Defensive rating from BDL teamseasonaverages/advanced. Per-100-possession '
  'points-allowed metric. NBA 2025-26 league avg ~113, range ~95-115. Lower '
  'is better defense. Single composite signal — preferred over PPG-allowed '
  'proxy for points/PRA/PA/PR player-prop scoring (May 5 megadeploy fallout).';
