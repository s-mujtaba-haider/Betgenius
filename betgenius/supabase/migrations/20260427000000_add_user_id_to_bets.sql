-- ============================================================================
-- Migration: add_user_id_to_bets
-- Created : 2026-04-27
-- Purpose : Prepare bets table for multi-user. All existing bets backfill to a
--           single placeholder UUID for the project owner. When auth ships in October,
--           replace the placeholder with each user's real auth UUID.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--             The UPDATE matches zero rows on re-run because no nulls remain.
--             COMMENT ON is overwrite-safe.
--
-- Cardinal Rule #4 documentation:
--   What     : ALTER bets, ADD user_id UUID NULL; backfill existing 676 rows
--              with placeholder UUID; CREATE INDEX on user_id.
--   Why      : C17 Real Money UI needs to scope queries to the current user.
--              Single-user placeholder is the simplest forward path that
--              survives auth migration.
--   When     : 2026-04-27, post-CEO-approval, manually via supabase db push
--              or SQL Editor paste.
--   Impact   : Adds one nullable column + one index. Existing app code does
--              not read user_id (no breakage). New Performance UI reads it.
--   Rollback : ALTER TABLE bets DROP COLUMN IF EXISTS user_id;
--              DROP INDEX IF EXISTS idx_bets_user_id;
-- ============================================================================

ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS user_id UUID NULL;

UPDATE bets
   SET user_id = '00000000-0000-0000-0000-000000000001'
 WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets(user_id);

COMMENT ON COLUMN bets.user_id IS
  'User who placed the bet. Single-user placeholder until auth ships.';
