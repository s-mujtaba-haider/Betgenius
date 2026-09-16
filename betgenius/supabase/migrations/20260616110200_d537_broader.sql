-- D-537 — no-op (superseded by 110300 + 110400). Earlier version referenced
-- a non-existent game_id column on props_cache; correct column was
-- discovered to be different (see 110400). Leaving as a no-op so
-- migration history stays linear.
DO $$ BEGIN
  RAISE NOTICE '[D-537 110200] no-op — superseded.';
END $$;
