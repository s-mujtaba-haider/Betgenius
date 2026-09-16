-- Make pick_history natural-key uniqueness partial — production rows only.
--
-- Background: prior unique constraint on (player_name, prop_type, line, game_date)
-- was added to support process-games' merge-duplicates upsert pattern (C21,
-- commit 723f144 Apr 29). It applies to ALL rows including is_synthetic=true.
-- That means backfill orchestrator (Phase 4) cannot insert a synthetic row
-- with the same natural key as the existing production row — exactly the
-- collision case for Option C re-scoring (the WHOLE POINT is one synthetic
-- per pre-megadeploy production row).
--
-- Fix: drop the existing constraint, replace with a PARTIAL unique index
-- that only constrains is_synthetic=false rows. Production cron's merge-
-- duplicates upsert continues to work because the partial index supports
-- ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic=false.
-- Synthetic rows are unconstrained at the natural-key level — the orchestrator
-- writes one per backfill_run × (player, prop, line, date), so duplicates
-- only occur if a backfill is re-run with the same run_id (which the
-- orchestrator prevents at the application layer).
--
-- Discovery: the constraint's auto-generated name is unknown (added via
-- ad-hoc SQL by CEO per framework C21 entry, not in tracked migrations).
-- We use a DO block to find and drop any UNIQUE constraint or index on
-- exactly those 4 columns.

-- Step 1: drop any existing UNIQUE CONSTRAINT on the natural key
DO $$
DECLARE
  c_name TEXT;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.pick_history'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) ILIKE '%player_name%'
       AND pg_get_constraintdef(oid) ILIKE '%prop_type%'
       AND pg_get_constraintdef(oid) ILIKE '%line%'
       AND pg_get_constraintdef(oid) ILIKE '%game_date%'
  LOOP
    EXECUTE format('ALTER TABLE public.pick_history DROP CONSTRAINT %I', c_name);
    RAISE NOTICE 'dropped constraint %', c_name;
  END LOOP;
END $$;

-- Step 2: drop any standalone UNIQUE INDEX (not constraint-backed) on the same columns
DO $$
DECLARE
  i_name TEXT;
BEGIN
  FOR i_name IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'pick_history'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%player_name%'
       AND indexdef ILIKE '%prop_type%'
       AND indexdef ILIKE '%line%'
       AND indexdef ILIKE '%game_date%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', i_name);
    RAISE NOTICE 'dropped index %', i_name;
  END LOOP;
END $$;

-- Step 3: create partial unique index for production rows only.
-- Production cron's process-games:2824 logUrl uses
-- ?on_conflict=player_name,prop_type,line,game_date — that on_conflict
-- target now resolves to THIS partial index (PostgREST/PostgreSQL match
-- via column set). The is_synthetic=false predicate is implicitly satisfied
-- because process-games never writes is_synthetic=true rows.
CREATE UNIQUE INDEX IF NOT EXISTS pick_history_production_natural_uniq
  ON public.pick_history (player_name, prop_type, line, game_date)
  WHERE is_synthetic = false;

COMMENT ON INDEX public.pick_history_production_natural_uniq IS
  'Partial unique index for production rows only (is_synthetic = false). Allows synthetic backfill rows to coexist with production rows for the same (player_name, prop_type, line, game_date). Replaces the original unconditional unique constraint.';
