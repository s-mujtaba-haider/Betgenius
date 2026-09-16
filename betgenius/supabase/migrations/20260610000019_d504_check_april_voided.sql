DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-504] April-stuck pick_history voided / actual_value detail:';
  FOR r IN
    SELECT b.id AS bet_id, ph.voided, ph.actual_value, ph.hit, ph.ai_analysis
    FROM public.bets b JOIN public.pick_history ph ON ph.id = b.pick_id
    WHERE b.status='pending' AND b.placed_at < NOW() - INTERVAL '3 days' AND b.pick_id IS NOT NULL
  LOOP
    RAISE NOTICE 'bet=% voided=% hit=% actual=% ai_first200=%',
      r.bet_id, COALESCE(r.voided::text, '<null>'), COALESCE(r.hit::text, '<null>'),
      COALESCE(r.actual_value::text, '<null>'),
      COALESCE(substring(r.ai_analysis, 1, 100), '<null>');
  END LOOP;
END $$;
