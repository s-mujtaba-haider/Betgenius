-- Map column overlap between recommendations_cache and pick_history.
-- Read-only NOTICE output. Used to design the May 7-9 backfill INSERT...SELECT.

DO $$
DECLARE
  v_row RECORD;
  v_in_both INTEGER := 0;
  v_only_pick INTEGER := 0;
  v_only_recs INTEGER := 0;
BEGIN
  RAISE NOTICE '=== column overlap audit @ % ===', NOW();

  RAISE NOTICE '';
  RAISE NOTICE '--- columns in BOTH tables (compatible types) ---';
  FOR v_row IN
    SELECT
      ph.column_name AS col,
      ph.data_type AS pick_type,
      rc.data_type AS recs_type
    FROM information_schema.columns ph
    JOIN information_schema.columns rc
      ON ph.column_name = rc.column_name
    WHERE ph.table_schema = 'public' AND ph.table_name = 'pick_history'
      AND rc.table_schema = 'public' AND rc.table_name = 'recommendations_cache'
    ORDER BY ph.column_name
  LOOP
    IF v_row.pick_type = v_row.recs_type THEN
      RAISE NOTICE '  %  (% / %)', v_row.col, v_row.pick_type, v_row.recs_type;
      v_in_both := v_in_both + 1;
    ELSE
      RAISE NOTICE '  %  ⚠ TYPE MISMATCH: pick_history=% recs_cache=%',
        v_row.col, v_row.pick_type, v_row.recs_type;
      v_in_both := v_in_both + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '--- columns ONLY in pick_history ---';
  FOR v_row IN
    SELECT ph.column_name, ph.data_type, ph.is_nullable, ph.column_default
    FROM information_schema.columns ph
    WHERE ph.table_schema = 'public' AND ph.table_name = 'pick_history'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns rc
        WHERE rc.table_schema = 'public' AND rc.table_name = 'recommendations_cache'
          AND rc.column_name = ph.column_name
      )
    ORDER BY ph.column_name
  LOOP
    RAISE NOTICE '  %  type=% null=% default=%',
      v_row.column_name, v_row.data_type, v_row.is_nullable, COALESCE(v_row.column_default, '(none)');
    v_only_pick := v_only_pick + 1;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '--- columns ONLY in recommendations_cache ---';
  FOR v_row IN
    SELECT rc.column_name, rc.data_type
    FROM information_schema.columns rc
    WHERE rc.table_schema = 'public' AND rc.table_name = 'recommendations_cache'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns ph
        WHERE ph.table_schema = 'public' AND ph.table_name = 'pick_history'
          AND ph.column_name = rc.column_name
      )
    ORDER BY rc.column_name
  LOOP
    RAISE NOTICE '  %  type=%', v_row.column_name, v_row.data_type;
    v_only_recs := v_only_recs + 1;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Summary: % shared, % only-in-pick_history, % only-in-recs_cache',
    v_in_both, v_only_pick, v_only_recs;

  -- Identify pick_history NOT NULL columns that aren't in recs_cache (must be defaulted)
  RAISE NOTICE '';
  RAISE NOTICE '--- pick_history NOT NULL columns absent from recs_cache (need explicit defaults in backfill) ---';
  FOR v_row IN
    SELECT ph.column_name, ph.data_type, ph.column_default
    FROM information_schema.columns ph
    WHERE ph.table_schema = 'public' AND ph.table_name = 'pick_history'
      AND ph.is_nullable = 'NO'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns rc
        WHERE rc.table_schema = 'public' AND rc.table_name = 'recommendations_cache'
          AND rc.column_name = ph.column_name
      )
    ORDER BY ph.column_name
  LOOP
    RAISE NOTICE '  %  type=% default=%',
      v_row.column_name, v_row.data_type, COALESCE(v_row.column_default, '(NONE — REQUIRED)');
  END LOOP;
END $$;
