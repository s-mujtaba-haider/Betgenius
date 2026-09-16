SET statement_timeout = '20s';
DO $$ DECLARE rec record;
BEGIN
  FOR rec IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bets'
      AND column_name IN ('id','pick_id','player_name','player_id','prop_type','status','payout','stake')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  %  %', rec.column_name, rec.data_type;
  END LOOP;
END $$;
