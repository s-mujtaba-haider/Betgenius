-- ============================================================================
-- Migration : 20260505000003_run_log_cache_errors.sql
-- Date      : 2026-05-05
-- Purpose   : Add `cache_write_errors` column to run_log so cache_* table
--             POST failures are visible as a first-class counter rather
--             than buried in the run_log.notes string (`cache_writes={...,
--             err:N}`). Closes second half of C32 per /tmp/run_log_diag_may5.md.
--
-- Context   :
--   - run_log.opp_stats_failed correctly tracks ESPN/BDL fetch failures
--     only (process-games:3153). Cache POST failures live in cacheCounts.
--     errors and surface in run_log.notes. CEO didn't notice the notes
--     string parsing.
--   - This column promotes the count to first-class. Companion writer
--     change in same deploy populates it from cacheCounts.errors.
--
-- Rollback  :
--     ALTER TABLE public.run_log DROP COLUMN IF EXISTS cache_write_errors;
-- ============================================================================

ALTER TABLE public.run_log
  ADD COLUMN IF NOT EXISTS cache_write_errors INTEGER DEFAULT 0;

COMMENT ON COLUMN public.run_log.cache_write_errors IS
  'Count of cache_* table POST failures during this cron run. Distinct '
  'from opp_stats_failed which tracks ESPN/BDL fetch failures only. '
  'Populated from cacheCounts.errors at logRun time (process-games). '
  'Compare against error_log entries with phase=cache-write for full '
  'failure context.';
