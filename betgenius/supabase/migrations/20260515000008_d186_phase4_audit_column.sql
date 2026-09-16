-- ============================================================================
-- Migration : 20260515000008_d186_phase4_audit_column.sql
-- Date      : 2026-05-15
-- Task      : D-186 Phase 4 audit-trail column. Add nullable
--             `confidence_pre_d186_phase4` to pick_history. The rescore-
--             backfill-picks edge function writes the row's original
--             `confidence` value here once, on first-time rescore. This
--             preserves the pre-rescore value for direct query auditability
--             and trivial rollback (UPDATE confidence = confidence_pre_d186_phase4
--             WHERE confidence_pre_d186_phase4 IS NOT NULL).
--
-- Pure additive : single ADD COLUMN IF NOT EXISTS, no behavior change.
--
-- Rollback :
--     ALTER TABLE public.pick_history DROP COLUMN IF EXISTS confidence_pre_d186_phase4;
-- ============================================================================

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS confidence_pre_d186_phase4 INTEGER;

COMMENT ON COLUMN public.pick_history.confidence_pre_d186_phase4 IS
  'D-186 Phase 4 audit column: stores the row''s confidence value at the '
  'moment of first rescore by rescore-backfill-picks. NULL = row has not '
  'been rescored. Non-null = original pre-rescore confidence, current '
  'confidence column is the new D-186-aware score. Rollback shortcut: '
  'UPDATE pick_history SET confidence = confidence_pre_d186_phase4 WHERE '
  'confidence_pre_d186_phase4 IS NOT NULL.';
