-- Diagnostic: count orphan synthetic picks across the 5 deleted backfill_runs
-- IDs that earlier today's session removed. (May 7, 2026 evening Item 4 prep.)

DO $$
DECLARE
  v_total INTEGER;
  v_orphan INTEGER;
  v_canon INTEGER;
  v_row RECORD;
BEGIN
  SELECT COUNT(*) INTO v_total FROM pick_history WHERE is_synthetic = true;
  RAISE NOTICE '[orphan inspect] is_synthetic=true total: %', v_total;

  SELECT COUNT(*) INTO v_orphan
  FROM pick_history
  WHERE is_synthetic = true
    AND backfill_run_id IN (
      '8dc8946f-bd2b-4c5e-af76-a7c872b79c16',
      '3dd7ba9c-ccc0-4cc2-9a8b-c1d53c734d78',
      '44c0075a-e3f2-4f31-8620-7489bbf48951',
      '72e4f6b0-be63-4ca3-bc75-4c27ee9fa23c',
      '07ae7124-d32d-4c42-bc9b-f1bbddc0c01e'
    );
  RAISE NOTICE '[orphan inspect] orphans across 5 deleted run IDs: %', v_orphan;

  RAISE NOTICE '[orphan inspect] per-run-id breakdown:';
  FOR v_row IN
    SELECT backfill_run_id::TEXT AS rid, COUNT(*) AS n
    FROM pick_history
    WHERE is_synthetic = true
      AND backfill_run_id IN (
        '8dc8946f-bd2b-4c5e-af76-a7c872b79c16',
        '3dd7ba9c-ccc0-4cc2-9a8b-c1d53c734d78',
        '44c0075a-e3f2-4f31-8620-7489bbf48951',
        '72e4f6b0-be63-4ca3-bc75-4c27ee9fa23c',
        '07ae7124-d32d-4c42-bc9b-f1bbddc0c01e'
      )
    GROUP BY backfill_run_id
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  %: %', v_row.rid, v_row.n;
  END LOOP;

  RAISE NOTICE '[orphan inspect] all distinct backfill_run_ids on synthetic rows:';
  FOR v_row IN
    SELECT backfill_run_id::TEXT AS rid, COUNT(*) AS n
    FROM pick_history
    WHERE is_synthetic = true
    GROUP BY backfill_run_id
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  %: %', v_row.rid, v_row.n;
  END LOOP;

  v_canon := v_total - v_orphan;
  RAISE NOTICE '[orphan inspect] expected canonical after cleanup: % (total %, orphans %)',
    v_canon, v_total, v_orphan;
END $$;
