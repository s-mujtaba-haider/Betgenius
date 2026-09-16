-- D-499-APPLY SHIP 2 — Capture the full algorithm_weights row AFTER apply
-- so SHIP 2's diff vs the pre-apply snapshot can prove "only 7 changed".
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-499-APPLY AFTER] full algorithm_weights row id=1 (compare to docs/loop/reports/d499apply_snapshot.json):';
  FOR r IN
    SELECT row_to_json(algorithm_weights) AS j FROM algorithm_weights WHERE id = 1
  LOOP
    RAISE NOTICE 'APPLIED_ROW_JSON %', r.j;
  END LOOP;
END $$;
