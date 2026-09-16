-- D-529 SHIP 2 — inspect the mlb_market_type CHECK constraint shape so the
-- parser in pick_history_writer.ts can extract the value list at runtime.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-529 §A] mlb_market_type CHECK constraint definitions:';
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS consrc
    FROM pg_constraint
    WHERE conrelid = 'public.pick_history'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%mlb_market_type%'
  LOOP RAISE NOTICE '  conname=% def=%', r.conname, r.consrc; END LOOP;
END $$;
