-- D-537 — Reconcile today's MLB games across the pipeline stages.
-- READ-ONLY.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '30s';

  RAISE NOTICE '======== D-537 §A: today schedule ========';
  -- What tables hold the schedule cache?
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name ILIKE '%scoreboard%' OR table_name ILIKE '%schedule%'
           OR table_name ILIKE '%mlb_game%')
    ORDER BY table_name
  LOOP RAISE NOTICE '[D-537 §A.0] candidate schedule table: %', r.table_name; END LOOP;
END $$;
