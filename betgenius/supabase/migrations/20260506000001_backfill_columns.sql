-- Backfill schema columns — Option C historical re-scoring (D-097, May 6, 2026)
--
-- Adds three columns to pick_history so synthetic backfill rows can be
-- distinguished from production rows. Required for:
--   1. Excluding synthetic rows from Performance dashboard / Kelly calibration
--   2. Re-running backfill without colliding with prior backfill rows
--   3. Tracking which algorithm version produced a synthetic row (so future
--      calibration changes can selectively invalidate stale backfills)
--
-- Pure additive — no DROP, no behavior change for existing rows. Production
-- writers (process-games, analyze-pick) continue inserting without these
-- columns; defaults handle the gap.
--
-- Per CEO Cardinal Rule §1.4: this is ALTER but NOT destructive. No data loss.
-- Rollback if needed: DROP COLUMN is_synthetic, backfill_run_id, algorithm_version
-- (zero existing rows depend on these columns post-migration).

ALTER TABLE pick_history
  ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS backfill_run_id UUID,
  ADD COLUMN IF NOT EXISTS algorithm_version TEXT;

-- Index for filtering synthetic rows out of dashboard queries.
-- Partial index on is_synthetic = true so production queries (filtering by
-- is_synthetic = false, which is 99.9%+ of rows) get small index scans
-- rather than full-table when joining backfill_run_id.
CREATE INDEX IF NOT EXISTS idx_pick_history_synthetic_run
  ON pick_history (backfill_run_id)
  WHERE is_synthetic = true;

-- Backfill runs registry — one row per backfill invocation. Tracked so
-- progress is observable mid-run + so multiple runs can be diffed.
CREATE TABLE IF NOT EXISTS backfill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  algorithm_version TEXT NOT NULL,
  dates_processed INTEGER DEFAULT 0,
  picks_generated INTEGER DEFAULT 0,
  picks_resolved INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
  notes TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_backfill_runs_started_at
  ON backfill_runs (started_at DESC);

COMMENT ON COLUMN pick_history.is_synthetic IS
  'True for rows produced by historical backfill (Option C re-scoring). Production dashboard queries should filter is_synthetic = false unless explicitly studying calibration.';

COMMENT ON COLUMN pick_history.backfill_run_id IS
  'FK reference to backfill_runs.id when is_synthetic = true. NULL for production rows.';

COMMENT ON COLUMN pick_history.algorithm_version IS
  'Marker for which scoring algorithm version produced this row. Production rows post-megadeploy: NULL or "2026-05-04-megadeploy". Backfill rows: explicit version string.';

COMMENT ON TABLE backfill_runs IS
  'Backfill invocation registry — one row per orchestrated re-scoring run. Provides observability for in-progress backfills and audit trail for completed runs.';
