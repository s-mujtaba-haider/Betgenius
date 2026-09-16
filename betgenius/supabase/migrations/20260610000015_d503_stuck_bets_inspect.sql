-- D-503 SHIP 1 — inspect stuck pending bets (>3 days old). READ-ONLY.
DO $$
DECLARE r RECORD;
  v_total_pending INT;
  v_total_bets INT;
BEGIN
  -- Headline counts
  SELECT count(*) INTO v_total_bets FROM public.bets;
  SELECT count(*) INTO v_total_pending FROM public.bets WHERE status = 'pending';
  RAISE NOTICE '[D-503] bets total=% pending=%', v_total_bets, v_total_pending;

  RAISE NOTICE '[D-503] all bets schema overview:';
  FOR r IN
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bets' ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  col % : % nullable=%', r.column_name, r.data_type, r.is_nullable;
  END LOOP;

  -- Stuck rows (>3 days old, status=pending)
  RAISE NOTICE '[D-503] STUCK pending bets (>3 days old):';
  FOR r IN
    SELECT id, placed_at, status, pick_id, player_name, prop_type, line,
           pick_side, odds, stake, book, sport, settled_at, result_value, payout
    FROM public.bets
    WHERE status = 'pending' AND placed_at < NOW() - INTERVAL '3 days'
    ORDER BY placed_at
  LOOP
    RAISE NOTICE 'id=% placed=% sport=% player=% prop=% line=% side=% odds=% stake=% pick_id=% settled=% result=%',
      r.id, r.placed_at, r.sport,
      COALESCE(r.player_name, '<null>'),
      COALESCE(r.prop_type, '<null>'),
      r.line,
      COALESCE(r.pick_side, '<null>'),
      r.odds, r.stake,
      COALESCE(r.pick_id::text, '<null>'),
      COALESCE(r.settled_at::text, '<null>'),
      COALESCE(r.result_value::text, '<null>');
  END LOOP;

  -- Same shape but for settled bets — to see what RESOLVED bets look like
  -- (commonality contrast).
  RAISE NOTICE '[D-503] sample of RECENTLY RESOLVED bets (status != pending, last 10):';
  FOR r IN
    SELECT id, placed_at, status, pick_id, player_name, prop_type, line,
           pick_side, sport, settled_at, result_value
    FROM public.bets
    WHERE status <> 'pending'
    ORDER BY settled_at DESC NULLS LAST
    LIMIT 10
  LOOP
    RAISE NOTICE 'id=% sport=% prop=% line=% side=% pick_id=% settled=% result=% status=%',
      r.id, r.sport,
      COALESCE(r.prop_type, '<null>'),
      r.line,
      COALESCE(r.pick_side, '<null>'),
      COALESCE(r.pick_id::text, '<null>'),
      COALESCE(r.settled_at::text, '<null>'),
      COALESCE(r.result_value::text, '<null>'),
      r.status;
  END LOOP;
END $$;
