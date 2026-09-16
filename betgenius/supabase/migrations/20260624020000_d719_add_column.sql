-- D-719 — Phase A: add nullable player_id column to pick_history. ADDITIVE, NON-BREAKING.
-- Column is NULLABLE so no existing row needs to be backfilled before the migration completes.
-- No code reads pick_history.player_id yet — this is purely a foundation move.

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS player_id INTEGER;

-- Index for the future player_id-based join path
CREATE INDEX IF NOT EXISTS idx_ph_player_id
  ON public.pick_history (player_id) WHERE player_id IS NOT NULL;

-- Force PostgREST to learn the new column
DO $$ BEGIN PERFORM pg_notify('pgrst', 'reload schema'); END $$;

-- Sanity NOTICE
DO $$ DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='player_id';
  RAISE NOTICE 'D-719 Phase A: pick_history.player_id column exists: %', n;
END $$;
