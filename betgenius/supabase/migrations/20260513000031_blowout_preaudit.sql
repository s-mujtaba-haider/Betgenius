-- Pre-audit: does score_blowout_risk column / w_blowout_risk weight already exist?
DO $$
DECLARE r RECORD; found_picks INT := 0; found_weights INT := 0;
BEGIN
  SELECT COUNT(*) INTO found_picks FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND column_name LIKE '%blowout%';
  RAISE NOTICE 'pick_history blowout columns: %', found_picks;

  SELECT COUNT(*) INTO found_weights FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights'
      AND column_name LIKE '%blowout%';
  RAISE NOTICE 'algorithm_weights blowout columns: %', found_weights;
END $$;
