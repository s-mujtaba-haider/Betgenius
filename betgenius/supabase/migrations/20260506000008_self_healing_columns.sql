-- Self-healing schema additions (May 6, 2026 evening).
--
-- Two columns added to support health-monitor auto-recovery actions:
--   1. cron_progress.retry_count — tracks how many times health-monitor
--      has reverted a stuck 'processing' row back to 'pending'. Once
--      retry_count > 3, the row is flagged 'failed' (stops infinite
--      retry loops on systemically bad games).
--   2. pick_history.resolution_note — free-text annotation for picks
--      auto-resolved by health-monitor (e.g., "auto-voided by
--      health-monitor: game status indicates void/postponed").
--      Distinguishes auto-resolution from manual or resolve-picks
--      cron resolutions during audit.
--
-- Both columns are nullable + IF NOT EXISTS — pure additive, idempotent.
-- No backfill required. Existing rows continue to work unchanged.

ALTER TABLE public.cron_progress
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

COMMENT ON COLUMN public.cron_progress.retry_count IS
  'Auto-recovery: incremented by health-monitor when stuck processing rows '
  'are reverted to pending. retry_count > 3 = flagged failed.';

COMMENT ON COLUMN public.pick_history.resolution_note IS
  'Free-text annotation for picks auto-resolved by health-monitor. NULL '
  'for picks resolved by resolve-picks cron or manual action.';
