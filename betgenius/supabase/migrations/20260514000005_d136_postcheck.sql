DO $$
DECLARE n1 INT; w NUMERIC;
BEGIN
  SELECT COUNT(*) INTO n1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='score_low_min_risk';
  RAISE NOTICE 'pick_history.score_low_min_risk exists: % (1=YES)', n1;

  SELECT w_low_min_risk INTO w FROM algorithm_weights WHERE id=1;
  RAISE NOTICE 'algorithm_weights.w_low_min_risk @ id=1: %', w;
END $$;
