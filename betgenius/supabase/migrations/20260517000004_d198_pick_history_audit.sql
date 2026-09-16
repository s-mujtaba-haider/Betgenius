-- D-198 — adds confidence_pre_tier_aware audit column to pick_history.
--
-- Mirrors the confidence_pre_d186_phase4 pattern (D-186 Phase 4): captures
-- the pre-modifier confidence so future tier-modifier ships can be diffed
-- against the unmodified baseline.
--
-- Nullable INT (no NOT NULL, no DEFAULT) — pre-D-198 rows correctly have
-- NULL; new writes can populate optionally.
--
-- §1.17 audit:
--   - Column add only; NULL default = explicit-omit-tolerant
--   - No COALESCE wrapping needed (no NOT NULL DEFAULT)
--   - Writer paths to update:
--     1. upsert_pick_history RPC — migration 20260517000005 regenerates RPC
--     2. backfill-bdl-historical direct POST — code update in same commit
--   - Read paths: none (audit column for forensic comparison only)
--
-- §1.14 N/A — no views touched.

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS confidence_pre_tier_aware INT;

COMMENT ON COLUMN public.pick_history.confidence_pre_tier_aware IS
  'D-198 Tier-Aware Scoring audit. Captures finalScore from scoreOneSide BEFORE per-tier weight modifiers apply. NULL on pre-D-198 rows. On post-D-198 rows: equals confidence column when tier modifiers are identity (1.0); differs when modifiers tuned via §19.3.';
